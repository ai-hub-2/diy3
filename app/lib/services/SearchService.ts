import {
  pipeline,
  env,
  type PipelineType,
  type TextVectorGenerationPipeline,
  type TextVectorGenerationSingle,
} from '@xenova/transformers';

// Skip local model check for environments like Cloudflare Pages
env.allowLocalModels = false;
env.useBrowserCache = false; // Disable caching for now, can be enabled later with IndexedDB

interface SearchResult {
  path: string;
  lineNumber?: number; // For text files, if applicable
  score: number;
  text: string; // The chunk of text that matched
  // Potentially add preview/context around the matched text
}

interface FileEmbeddings {
  path:string;
  embeddings: Array<{
    chunk: string;
    vector: number[];
    // Optional: add line numbers or character offsets for precise linking
    lineNumberStart?: number;
    lineNumberEnd?: number;
  }>;
}

// --- Pure JS Cosine Similarity ---
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    // console.warn('Vectors have different lengths, cannot compute similarity.');
    return 0;
  }
  const dotProduct = a.reduce((sum, val, i) => sum + (val * b[i]), 0);
  const magnitudeA = Math.sqrt(a.reduce((sum, val) => sum + (val * val), 0));
  const magnitudeB = Math.sqrt(b.reduce((sum, val) => sum + (val * val), 0));
  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0; // Avoid division by zero
  }
  return dotProduct / (magnitudeA * magnitudeB);
}


class SearchService {
  private static instance: SearchService;
  private model: TextVectorGenerationPipeline | null = null;
  private modelName: string = 'sentence-transformers/all-MiniLM-L6-v2';
  private indexedFiles: Map<string, FileEmbeddings> = new Map();
  private isInitializing: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor to enforce singleton
  }

  public static getInstance(): SearchService {
    if (!SearchService.instance) {
      SearchService.instance = new SearchService();
    }
    return SearchService.instance;
  }

  private async initializeModel(): Promise<void> {
    if (this.model) return;
    if (this.isInitializing && this.initializationPromise) {
      return this.initializationPromise;
    }

    this.isInitializing = true;
    this.initializationPromise = (async () => {
      try {
        console.log('Initializing search model...');
        this.model = (await pipeline(
          'feature-extraction',
          this.modelName,
          { quantized: true } // Use quantized model for better performance/size
        )) as TextVectorGenerationPipeline;
        console.log('Search model initialized successfully.');
      } catch (error) {
        console.error('Failed to initialize search model:', error);
        this.model = null; // Ensure model is null if initialization fails
        throw error; // Re-throw to allow caller to handle
      } finally {
        this.isInitializing = false;
      }
    })();
    return this.initializationPromise;
  }

  // Simple tokenizer and chunker (can be improved)
  private chunkText(text: string, chunkSize: number = 256, overlap: number = 30): string[] {
    // Basic whitespace tokenizer
    const tokens = text.split(/\s+/).filter(token => token.length > 0);
    const chunks: string[] = [];
    if (tokens.length === 0) return [];

    let currentChunkTokens: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      currentChunkTokens.push(tokens[i]);
      if (currentChunkTokens.length >= chunkSize || i === tokens.length - 1) {
        chunks.push(currentChunkTokens.join(' '));
        // Create overlapping chunks
        if (i < tokens.length - 1) { // Ensure we don't create an overlap from the very end
            const startIndexForOverlap = Math.max(0, currentChunkTokens.length - overlap);
            currentChunkTokens = currentChunkTokens.slice(startIndexForOverlap);
        } else {
            currentChunkTokens = [];
        }
      }
    }
    return chunks.filter(chunk => chunk.trim().length > 0);
  }

  public async indexFile(filePath: string, content: string): Promise<void> {
    await this.initializeModel();
    if (!this.model) {
      console.error('Search model not initialized. Cannot index file.');
      return;
    }

    // console.log(`Indexing file: ${filePath}`);
    const chunks = this.chunkText(content);
    if (chunks.length === 0) {
      // console.log(`No content to index in ${filePath}`);
      this.indexedFiles.delete(filePath); // Remove if it was previously indexed but now empty
      return;
    }

    const fileEmbeddings: FileEmbeddings = { path: filePath, embeddings: [] };

    try {
      for (const chunk of chunks) {
        // Ensure the model is not called with an empty string
        if (chunk.trim().length === 0) continue;

        const output: TextVectorGenerationSingle = await this.model(chunk, {
          pooling: 'mean',
          normalize: true,
        });
        fileEmbeddings.embeddings.push({
          chunk: chunk,
          vector: Array.from(output.data as Float32Array), // Convert Float32Array to number[]
        });
      }
      this.indexedFiles.set(filePath, fileEmbeddings);
      // console.log(`Successfully indexed ${fileEmbeddings.embeddings.length} chunks for ${filePath}`);
    } catch (error) {
      console.error(`Error indexing file ${filePath}:`, error);
    }
  }

  public removeFile(filePath: string): void {
    this.indexedFiles.delete(filePath);
    // console.log(`Removed file from search index: ${filePath}`);
  }

  public isFileIndexed(filePath: string): boolean {
    return this.indexedFiles.has(filePath);
  }

  public async search(query: string, topK: number = 10): Promise<SearchResult[]> {
    await this.initializeModel();
    if (!this.model || this.indexedFiles.size === 0) {
      // console.log('Model not ready or no files indexed.');
      return [];
    }

    // console.log(`Searching for: "${query}"`);
    if (query.trim().length === 0) return [];

    let queryVector: number[];
    try {
      const queryEmbedding: TextVectorGenerationSingle = await this.model(query, {
        pooling: 'mean',
        normalize: true,
      });
      queryVector = Array.from(queryEmbedding.data as Float32Array);
    } catch (error) {
      console.error('Error generating query embedding:', error);
      return [];
    }

    const results: SearchResult[] = [];

    this.indexedFiles.forEach((fileData) => {
      fileData.embeddings.forEach((chunkData) => {
        const similarity = cosineSimilarity(queryVector, chunkData.vector);
        if (similarity > 0) { // Threshold can be adjusted
          results.push({
            path: fileData.path,
            score: similarity,
            text: chunkData.chunk,
          });
        }
      });
    });

    // Sort results by score in descending order and take topK
    results.sort((a, b) => b.score - a.score);
    // console.log(`Found ${results.length} potential matches, returning top ${topK}`);
    return results.slice(0, topK);
  }

  public getIndexedFilesCount(): number {
    return this.indexedFiles.size;
  }

  public clearIndex(): void {
    this.indexedFiles.clear();
    console.log('Search index cleared.');
  }
}

export default SearchService;

/*
Example Usage (Conceptual - to be integrated into UI components):

// --- Initialization (e.g., in a global setup or on demand) ---
const searchService = SearchService.getInstance();
// No need to explicitly call initializeModel, it's handled by indexFile/search

// --- Indexing a file (e.g., when a file is opened or modified) ---
// Assuming `filePath` is like 'src/components/Button.tsx'
// and `fileContent` is the string content of the file
// searchService.indexFile(filePath, fileContent);

// --- Performing a search (e.g., from a search dialog) ---
// const query = "find all API calls";
// searchService.search(query).then(results => {
//   console.log("Search Results:", results);
//   // Update UI with results
//   // Each result object: { path: string, score: number, text: string (matched chunk) }
// });

// --- Removing a file from index (e.g., when a file is closed or deleted) ---
// searchService.removeFile(filePathToRemove);

// --- UI Integration for CTRL+K ---
// This would typically be in a React component
// useEffect(() => {
//   const handleKeyDown = (event: KeyboardEvent) => {
//     if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
//       event.preventDefault();
//       // Open your search dialog here
//       console.log('CTRL+K pressed, open search dialog');
//     }
//     if (event.key === '/' && (event.target as HTMLElement).tagName !== 'INPUT' && (event.target as HTMLElement).tagName !== 'TEXTAREA') {
//       event.preventDefault();
//       // Open your search dialog here, perhaps pre-fill the search input with '/'
//       console.log('/ pressed, open search dialog');
//     }
//   };
//   window.addEventListener('keydown', handleKeyDown);
//   return () => {
//     window.removeEventListener('keydown', handleKeyDown);
//   };
// }, []);

*/

// Dependencies to install:
// npm install @xenova/transformers
// or
// pnpm install @xenova/transformers
// or
// yarn add @xenova/transformers
//
// Note: If you encounter issues with onnxruntime-node during installation,
// you might need to ensure build tools like CMake and Python are available
// in your environment, or use the `--legacy-peer-deps` flag if conflicts arise.
// However, this SearchService.ts is designed to work with the browser-compatible
// version of Transformers.js that typically avoids heavy native dependencies
// when `env.allowLocalModels = false;` is set.
