export interface Commit {
    hash: string;
    shortHash: string;
    subject: string;
    authorName: string;
    authorDate: string;
    refs: string;
    // Full parent hashes (git %P), space-separated in raw git output - empty
    // for a root commit, 2+ entries for a merge. Feeds the commit-graph lane
    // layout in webview/graph.ts; unrelated to the flat log-list rendering.
    parentHashes: string[];
}

export interface CommitDetail {
    hash: string;
    shortHash: string;
    authorName: string;
    authorEmail: string;
    authorDate: string;
    body: string;
}

export interface FileChange {
    path: string;
    oldPath?: string;
    status: string;
    additions: number;
    deletions: number;
    parentGroup?: string;
}

export type WebviewMode = 'log' | 'compare' | 'blame';

export interface InitialState {
    mode: WebviewMode;
    targetPath?: string;
    isFile?: boolean;
    sha1?: string;
    sha2?: string;
    blameSha?: string;
    blameFilePath?: string;
    lineStart?: number;
    lineEnd?: number;
    pageSize?: number;
}

export interface BlameLineData {
    sha: string;
    shortSha: string;
    author: string;
    authorEmail: string;
    timestamp: number;
    date: string;
    summary: string;
    lineNo: number;
    content: string;
}

export interface RequestCommitsMessage {
    type: 'requestCommits';
    offset: number;
    count: number;
    after?: string;
    before?: string;
    branches?: 'all' | string[];
}

export interface RequestBranchesMessage {
    type: 'requestBranches';
}

export interface RequestCommitRefsMessage {
    type: 'requestCommitRefs';
    sha: string;
}

export interface RequestCommitDetailsMessage {
    type: 'requestCommitDetails';
    sha: string;
}

export interface CompareWithPreviousMessage {
    type: 'compareWithPrevious';
    sha: string;
    previousSha?: string;
    filePath: string;
    oldPath?: string;
    status: string;
}

export interface CompareWithWorkingTreeMessage {
    type: 'compareWithWorkingTree';
    sha: string;
    filePath: string;
    oldPath?: string;
    status: string;
}

export interface ViewFileContentsMessage {
    type: 'viewFileContents';
    sha: string;
    filePath: string;
}

export interface BlameMessage {
    type: 'blame';
    sha: string;
    filePath: string;
}

export interface CompareRevisionsMessage {
    type: 'compareRevisions';
    sha1: string;
    sha2: string;
}

export interface RequestCompareFilesMessage {
    type: 'requestCompareFiles';
}

export interface CompareFileMessage {
    type: 'compareFile';
    filePath: string;
    oldPath?: string;
    status: string;
}

export interface ShowFileLogMessage {
    type: 'showFileLog';
    filePath: string;
}

export interface RequestBlameDataMessage {
    type: 'requestBlameData';
}

export interface CommitsLoadedMessage {
    type: 'commitsLoaded';
    commits: Commit[];
    hasMore: boolean;
    // Only present for a path-scoped request's first page (File Log,
    // Folder View) - real, unscoped parent-hash data the commit graph
    // needs to connect around commits `commits` itself never returns (git
    // log -- path never includes commits that didn't touch that path,
    // even though they're real intermediate parents of ones that did).
    // Absent entirely for the main (unscoped) log, which never needs it.
    graphEdges?: Commit[];
}

export interface BranchesLoadedMessage {
    type: 'branchesLoaded';
    branches: string[];
}

export interface CommitRefsLoadedMessage {
    type: 'commitRefsLoaded';
    sha: string;
    branches: string[];
    tags: string[];
}

export interface CommitDetailsLoadedMessage {
    type: 'commitDetailsLoaded';
    detail: CommitDetail;
    files: FileChange[];
}

export interface CompareFilesLoadedMessage {
    type: 'compareFilesLoaded';
    files: FileChange[];
    detail1: CommitDetail;
    detail2: CommitDetail;
}

export interface BlameDataLoadedMessage {
    type: 'blameDataLoaded';
    lines: BlameLineData[];
    commits: Record<string, CommitDetail>;
}

export interface ErrorMessage {
    type: 'error';
    message: string;
}
