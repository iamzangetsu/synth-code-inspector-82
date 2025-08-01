import { analyzeCode } from './aiDetection';
import type { AnalysisResult, LineAnalysis } from './aiDetection';

export interface FileAnalysis {
  path: string;
  language: string;
  analysis: AnalysisResult;
  size: number;
}

export interface RepositoryAnalysis {
  repositoryUrl: string;
  totalFiles: number;
  analyzedFiles: number;
  files: FileAnalysis[];
  isLovableGenerated: boolean;
  lovableIndicators: string[];
  overallStats: {
    totalLines: number;
    aiLines: number;
    humanLines: number;
    aiPercentage: number;
    humanPercentage: number;
    overallConfidence: number;
  };
}

interface GitHubFile {
  name: string;
  path: string;
  type: 'file' | 'dir';
  download_url?: string;
  size: number;
}

// Language detection based on file extensions
const LANGUAGE_MAP: Record<string, string> = {
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.py': 'python',
  '.java': 'java',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.cs': 'csharp',
  '.go': 'go',
  '.rs': 'rust',
  '.php': 'php',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.sh': 'bash',
  '.sql': 'sql',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.xml': 'xml',
  '.md': 'markdown'
};

function getLanguageFromPath(filePath: string): string {
  const ext = filePath.toLowerCase().match(/\.[^.]*$/)?.[0];
  return ext ? LANGUAGE_MAP[ext] || 'text' : 'text';
}

function shouldAnalyzeFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().match(/\.[^.]*$/)?.[0];
  if (!ext) return false;
  
  // Only analyze code files
  const codeExtensions = ['.js', '.jsx', '.ts', '.tsx', '.py', '.java', '.cpp', '.cc', '.cxx', '.c++', '.cs', '.go', '.rs', '.php', '.rb', '.swift', '.kt', '.scala', '.vue', '.svelte'];
  if (!codeExtensions.includes(ext)) return false;
  
  // Skip framework-provided and generated files
  const excludePatterns = [
    // Framework UI components (shadcn/ui, etc.)
    /\/components\/ui\//,
    /\/ui\//,
    /\.shadcn\//,
    
    // Build and dependency folders
    /node_modules\//,
    /dist\//,
    /build\//,
    /\.next\//,
    /\.nuxt\//,
    /coverage\//,
    
    // Generated files
    /\.generated\./,
    /\.gen\./,
    /\.d\.ts$/,
    /types\.ts$/,
    /index\.d\.ts$/,
    
    // Configuration files (usually auto-generated or boilerplate)
    /tailwind\.config\./,
    /vite\.config\./,
    /webpack\.config\./,
    /next\.config\./,
    /nuxt\.config\./,
    /rollup\.config\./,
    /babel\.config\./,
    /jest\.config\./,
    /vitest\.config\./,
    /postcss\.config\./,
    /eslint\.config\./,
    /prettier\.config\./,
    
    // Package files
    /package\.json$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /bun\.lockb$/,
    
    // Common boilerplate files
    /\/(main|index)\.(js|ts|jsx|tsx)$/,
    /App\.(js|ts|jsx|tsx)$/,
    
    // Test files (unless specifically requested)
    /\.(test|spec)\.(js|ts|jsx|tsx)$/,
    /__tests__\//,
    /\.test\//,
    
    // Documentation
    /\.md$/,
    /\.mdx$/,
    
    // Hidden and config folders
    /\/\./,
    /\.git\//,
    /\.vscode\//,
    /\.idea\//
  ];
  
  // Check if file should be excluded
  for (const pattern of excludePatterns) {
    if (pattern.test(filePath)) {
      return false;
    }
  }
  
  // Additional checks for boilerplate files in src folder
  if (filePath.includes('src/') && 
      (filePath.match(/\/(main|index)\.(js|ts|jsx|tsx)$/) || 
       filePath.match(/App\.(js|ts|jsx|tsx)$/))) {
    return false;
  }
  
  return true;
}

async function fetchGitHubContents(owner: string, repo: string, path: string = ''): Promise<GitHubFile[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    const data = await response.json();
    return Array.isArray(data) ? data : [data];
  } catch (error) {
    console.error(`Error fetching GitHub contents for ${owner}/${repo}/${path}:`, error);
    throw error;
  }
}

async function fetchFileContent(downloadUrl: string): Promise<string> {
  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch file: ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    console.error(`Error fetching file content from ${downloadUrl}:`, error);
    throw error;
  }
}

function shouldSkipDirectory(dirPath: string, dirName: string): boolean {
  // Skip common directories that don't contain developer-written code
  const skipPatterns = [
    // Dependencies and build outputs
    'node_modules',
    'dist',
    'build',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output',
    'public',
    'static',
    'assets',
    
    // Framework generated folders
    'components/ui',
    '.generated',
    '.gen',
    
    // Version control and IDE
    '.git',
    '.svn',
    '.hg',
    '.vscode',
    '.idea',
    '.vs',
    
    // Config folders
    '.husky',
    '.github',
    '.gitlab',
    
    // Temp folders
    'tmp',
    'temp',
    '.cache',
    '.temp'
  ];
  
  // Check exact matches
  if (skipPatterns.includes(dirName)) return true;
  
  // Check path patterns
  if (dirPath.includes('/node_modules/') || 
      dirPath.includes('/components/ui/') ||
      dirPath.includes('/.') ||
      dirPath.includes('/dist/') ||
      dirPath.includes('/build/')) {
    return true;
  }
  
  return false;
}

async function fetchRepositoryMetadata(owner: string, repo: string) {
  const url = `https://api.github.com/repos/${owner}/${repo}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`Error fetching repository metadata for ${owner}/${repo}:`, error);
    throw error;
  }
}

async function fetchCommits(owner: string, repo: string, limit: number = 30) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits?per_page=${limit}`;
  
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error(`Error fetching commits for ${owner}/${repo}:`, error);
    return [];
  }
}

async function detectLovableGeneration(metadata: any, commits: any[], allFiles: GitHubFile[], owner: string, repo: string): Promise<{ isLovable: boolean; indicators: string[] }> {
  const indicators: string[] = [];
  
  // Check repository description (only if metadata is available)
  if (metadata?.description?.toLowerCase().includes('lovable')) {
    indicators.push('Repository description mentions Lovable');
  }
  
  // Check for lovable-dev[bot] commits
  const lovableBotCommits = commits.filter(commit => 
    commit.author?.login === 'lovable-dev[bot]' || 
    commit.commit?.author?.name?.includes('lovable-dev') ||
    commit.commit?.author?.email?.includes('lovable.dev')
  );
  
  if (lovableBotCommits.length > 0) {
    indicators.push(`Found ${lovableBotCommits.length} commits by lovable-dev[bot]`);
  }
  
  // Check commit messages for Lovable patterns
  const lovableCommitMessages = commits.filter(commit =>
    commit.commit?.message?.toLowerCase().includes('lovable') ||
    commit.commit?.message?.toLowerCase().includes('ai generated') ||
    commit.commit?.message?.toLowerCase().includes('auto-generated')
  );
  
  if (lovableCommitMessages.length > 0) {
    indicators.push(`Found ${lovableCommitMessages.length} commits with Lovable-related messages`);
  }
  
  // Check specific files for Lovable keywords
  const filesToCheck = [
    { path: 'index.html', name: 'index.html' },
    { path: 'package.json', name: 'package.json' },
    { path: 'README.md', name: 'README.md' }
  ];
  
  for (const fileToCheck of filesToCheck) {
    const file = allFiles.find(f => f.name.toLowerCase() === fileToCheck.name.toLowerCase() || f.path === fileToCheck.path);
    if (file && file.download_url) {
      try {
        const content = await fetchFileContent(file.download_url);
        if (content.toLowerCase().includes('lovable')) {
          indicators.push(`Found "lovable" keyword in ${fileToCheck.name}`);
        }
      } catch (error) {
        console.warn(`Could not check ${fileToCheck.name} for Lovable keywords:`, error);
      }
    }
  }
  
  // Check for typical Lovable project structure
  const lovableFiles = [
    'components.json',
    'src/lib/utils.ts',
    'src/components/ui/',
    'tailwind.config.ts',
    'vite.config.ts'
  ];
  
  let foundLovableFiles = 0;
  for (const lovableFile of lovableFiles) {
    if (allFiles.some(file => file.path.includes(lovableFile))) {
      foundLovableFiles++;
    }
  }
  
  if (foundLovableFiles >= 3) {
    indicators.push('Project structure matches Lovable template');
  }
  
  // Check for shadcn/ui components
  const uiComponents = allFiles.filter(file => file.path.includes('src/components/ui/'));
  if (uiComponents.length > 5) {
    indicators.push(`Found ${uiComponents.length} shadcn/ui components`);
  }
  
  return {
    isLovable: indicators.length >= 2 || lovableBotCommits.length > 0,
    indicators
  };
}

async function getAllFiles(owner: string, repo: string, path: string = '', maxDepth: number = 4): Promise<GitHubFile[]> {
  if (maxDepth <= 0) return [];
  
  const contents = await fetchGitHubContents(owner, repo, path);
  const allFiles: GitHubFile[] = [];
  
  for (const item of contents) {
    if (item.type === 'file') {
      allFiles.push(item);
    } else if (item.type === 'dir' && !shouldSkipDirectory(item.path, item.name)) {
      // Recursively fetch directory contents
      try {
        const subFiles = await getAllFiles(owner, repo, item.path, maxDepth - 1);
        allFiles.push(...subFiles);
      } catch (error) {
        console.warn(`Skipping directory ${item.path}:`, error);
      }
    }
  }
  
  return allFiles;
}

export async function analyzeGitHubRepository(
  repositoryUrl: string,
  onProgress?: (current: number, total: number, currentFile: string) => void
): Promise<RepositoryAnalysis> {
  // Parse GitHub URL
  const urlMatch = repositoryUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!urlMatch) {
    throw new Error('Invalid GitHub repository URL. Please use format: https://github.com/owner/repo');
  }
  
  const [, owner, repo] = urlMatch;
  
  // Fetch all files first (core functionality)
  onProgress?.(0, 1, 'Fetching repository structure...');
  const allFiles = await getAllFiles(owner, repo);
  
  // Try to fetch metadata and commits for Lovable detection (optional)
  let metadata = null;
  let commits: any[] = [];
  
  try {
    onProgress?.(0, 1, 'Fetching repository metadata...');
    [metadata, commits] = await Promise.all([
      fetchRepositoryMetadata(owner, repo).catch(() => null),
      fetchCommits(owner, repo).catch(() => [])
    ]);
  } catch (error) {
    console.warn('Could not fetch repository metadata for Lovable detection:', error);
  }
  
  // Filter files we can analyze
  const analyzeableFiles = allFiles.filter(file => 
    shouldAnalyzeFile(file.path) && 
    file.size && 
    file.size < 1024 * 1024 && // Skip files larger than 1MB
    file.download_url
  );
  
  if (analyzeableFiles.length === 0) {
    throw new Error('No analyzeable code files found in this repository');
  }
  
  const fileAnalyses: FileAnalysis[] = [];
  let totalLines = 0;
  let totalAiLines = 0;
  let totalHumanLines = 0;
  let totalConfidence = 0;
  let analyzedCount = 0;
  
  // Analyze each file
  for (let i = 0; i < analyzeableFiles.length; i++) {
    const file = analyzeableFiles[i];
    onProgress?.(i + 1, analyzeableFiles.length, file.path);
    
    try {
      const content = await fetchFileContent(file.download_url!);
      const language = getLanguageFromPath(file.path);
      
      // Skip empty files
      if (!content.trim()) continue;
      
      const analysis = await analyzeCode(content, language);
      
      fileAnalyses.push({
        path: file.path,
        language,
        analysis,
        size: file.size || 0
      });
      
      totalLines += analysis.totalLines;
      totalAiLines += analysis.aiLines;
      totalHumanLines += analysis.humanLines;
      totalConfidence += analysis.overallConfidence;
      analyzedCount++;
      
    } catch (error) {
      console.warn(`Failed to analyze ${file.path}:`, error);
    }
  }
  
  // Detect if repository was generated by Lovable
  const lovableDetection = await detectLovableGeneration(metadata, commits, allFiles, owner, repo);
  
  const overallStats = {
    totalLines,
    aiLines: totalAiLines,
    humanLines: totalHumanLines,
    aiPercentage: totalLines > 0 ? (totalAiLines / totalLines) * 100 : 0,
    humanPercentage: totalLines > 0 ? (totalHumanLines / totalLines) * 100 : 0,
    overallConfidence: analyzedCount > 0 ? totalConfidence / analyzedCount : 0
  };
  
  return {
    repositoryUrl,
    totalFiles: allFiles.length,
    analyzedFiles: fileAnalyses.length,
    files: fileAnalyses,
    isLovableGenerated: lovableDetection.isLovable,
    lovableIndicators: lovableDetection.indicators,
    overallStats
  };
}