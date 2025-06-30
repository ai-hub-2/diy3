import { useState, useMemo, useCallback, useEffect } from 'react';
import { workbenchStore } from '~/lib/stores/workbench';
import { debounce } from '~/utils/debounce';
import SearchService from '~/lib/services/SearchService'; // Import the new SearchService

// Interface for search results from SearchService
interface SemanticMatch {
  path: string;
  lineNumber?: number; // Optional: if chunks are associated with lines
  score: number;
  text: string; // The matched chunk of text
}

// Helper function to group results by file
function groupSemanticResultsByFile(results: SemanticMatch[]): Record<string, SemanticMatch[]> {
  return results.reduce(
    (acc, result) => {
      if (!acc[result.path]) {
        acc[result.path] = [];
      }
      acc[result.path].push(result);
      return acc;
    },
    {} as Record<string, SemanticMatch[]>,
  );
}

export function Search() {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SemanticMatch[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  const [hasSearched, setHasSearched] = useState(false);
  const searchService = SearchService.getInstance();

  const groupedResults = useMemo(() => groupSemanticResultsByFile(searchResults), [searchResults]);

  useEffect(() => {
    if (searchResults.length > 0) {
      const allExpanded: Record<string, boolean> = {};
      Object.keys(groupedResults).forEach((file) => {
        allExpanded[file] = true;
      });
      setExpandedFiles(allExpanded);
    }
  }, [groupedResults, searchResults]);

  const handleSearch = useCallback(
    async (query: string) => {
      if (!query.trim()) {
        setSearchResults([]);
        setIsSearching(false);
        setExpandedFiles({});
        setHasSearched(false);
        return;
      }

      setIsSearching(true);
      setSearchResults([]); // Clear previous results
      setExpandedFiles({});
      setHasSearched(true);

      const minLoaderTime = 300; // ms
      const start = Date.now();

      try {
        // Use the SearchService
        const results = await searchService.search(query);
        setSearchResults(results);
      } catch (error) {
        console.error('Failed to perform semantic search:', error);
        setSearchResults([]); // Ensure results are cleared on error
      } finally {
        const elapsed = Date.now() - start;
        if (elapsed < minLoaderTime) {
          setTimeout(() => setIsSearching(false), minLoaderTime - elapsed);
        } else {
          setIsSearching(false);
        }
      }
    },
    [searchService],
  ); // Added searchService to dependencies

  const debouncedSearch = useCallback(debounce(handleSearch, 300), [handleSearch]);

  useEffect(() => {
    debouncedSearch(searchQuery);
  }, [searchQuery, debouncedSearch]);

  const handleResultClick = (filePath: string, line?: number) => {
    workbenchStore.setSelectedFile(filePath);
    // For semantic search, line number might be less precise or chunk-based.
    // If your SearchService provides line numbers, use them. Otherwise, you might scroll to top of file.
    const adjustedLine = typeof line === 'number' ? Math.max(0, line - 1) : 0; // Default to top if no line
    workbenchStore.setCurrentDocumentScrollPosition({ line: adjustedLine, column: 0 });
  };

  // Effect to listen for selected file changes and index them
  useEffect(() => {
    const unsubscribe = workbenchStore.selectedFile.subscribe(async (selectedFilePath) => {
      if (selectedFilePath) {
        const file = workbenchStore.files.get()[selectedFilePath];
        if (file?.type === 'file' && !file.isBinary && file.content && !searchService.isFileIndexed(selectedFilePath)) {
          console.log(`Indexing opened file: ${selectedFilePath}`);
          await searchService.indexFile(selectedFilePath, file.content);
          console.log(`File ${selectedFilePath} indexed. Total indexed: ${searchService.getIndexedFilesCount()}`);
        }
      }
    });
    return () => unsubscribe();
  }, [searchService]);


  // Keyboard shortcut for search (Ctrl+K or /)
  // This might be better placed in a global layout component
  // For now, adding it here for demonstration if this component is always mounted
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const targetElement = event.target as HTMLElement;
      const isInputFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(targetElement.tagName) || targetElement.isContentEditable;

      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault();
        // Assuming the search input should be focused
        document.querySelector<HTMLInputElement>('.search-input-field')?.focus();
      }
      if (event.key === '/' && !isInputFocused) {
        event.preventDefault();
         // Assuming the search input should be focused
        document.querySelector<HTMLInputElement>('.search-input-field')?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);


  return (
    <div className="flex flex-col h-full bg-bolt-elements-background-depth-2">
      {/* Search Bar */}
      <div className="flex items-center py-3 px-3">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Semantic Search (e.g., 'user authentication logic')"
            className="search-input-field w-full px-2 py-1 rounded-md bg-bolt-elements-background-depth-3 text-bolt-elements-textPrimary placeholder-bolt-elements-textTertiary focus:outline-none transition-all"
          />
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-auto py-2">
        {isSearching && (
          <div className="flex items-center justify-center h-32 text-bolt-elements-textTertiary">
            <div className="i-ph:circle-notch animate-spin mr-2" /> Searching...
          </div>
        )}
        {!isSearching && hasSearched && searchResults.length === 0 && searchQuery.trim() !== '' && (
          <div className="flex items-center justify-center h-32 text-gray-500">No results found.</div>
        )}
        {!isSearching &&
          Object.keys(groupedResults).map((file) => (
            <div key={file} className="mb-2">
              <button
                className="flex gap-2 items-center w-full text-left py-1 px-2 text-bolt-elements-textSecondary bg-transparent hover:bg-bolt-elements-background-depth-3 group"
                onClick={() => setExpandedFiles((prev) => ({ ...prev, [file]: !prev[file] }))}
              >
                <span
                  className=" i-ph:caret-down-thin w-3 h-3 text-bolt-elements-textSecondary transition-transform"
                  style={{ transform: expandedFiles[file] ? 'rotate(180deg)' : undefined }}
                />
                <span className="font-normal text-sm">{file.split('/').pop()}</span>
                <span className="h-5.5 w-5.5 flex items-center justify-center text-xs ml-auto bg-bolt-elements-item-backgroundAccent text-bolt-elements-item-contentAccent rounded-full">
                  {groupedResults[file].length}
                </span>
              </button>
              {expandedFiles[file] && (
                <div className="">
                  {groupedResults[file].map((match, idx) => (
                    <div
                      key={idx}
                      className="hover:bg-bolt-elements-background-depth-3 cursor-pointer transition-colors pl-6 py-1"
                      onClick={() => handleResultClick(match.path, match.lineNumber)}
                      title={`Score: ${match.score.toFixed(3)}`}
                    >
                      <pre className="font-mono text-xs text-bolt-elements-textTertiary whitespace-pre-wrap break-words">
                        {/* For semantic matches, we display the matched chunk directly */}
                        {/* Highlighting the exact query within the chunk is more complex with embeddings */}
                        {/* and might not always be directly applicable. */}
                        {match.text}
                      </pre>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
      </div>
    </div>
  );
}
