export interface Commit {
    hash: string;
    shortHash: string;
    subject: string;
    authorName: string;
    authorDate: string;
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
