import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface FixtureRepo {
    repoRoot: string;
    commits: Record<string, string>;
    tags: string[];
    branches: string[];
    files: string[];
    authors: Author[];
    cleanup: () => void;
}

interface Author {
    name: string;
    email: string;
}

const AUTHORS: Author[] = [
    { name: 'Alice Anderson', email: 'alice@test.com' },
    { name: 'Bob Builder', email: 'bob@test.com' },
    { name: 'Carol Chen', email: 'carol@test.com' },
    { name: 'Dave Davis', email: 'dave@test.com' },
    { name: 'Eve Edwards', email: 'eve@test.com' },
    { name: 'Frank Fisher', email: 'frank@test.com' },
    { name: 'Grace Garcia', email: 'grace@test.com' },
    { name: 'Henry Hill', email: 'henry@test.com' },
    { name: 'Iris Irving', email: 'iris@test.com' },
    { name: 'Jack Jones', email: 'jack@test.com' },
];

const DIRS = [
    'src/components', 'src/pages', 'src/utils', 'src/services',
    'src/models', 'src/middleware', 'tests/unit', 'tests/integration',
    'docs', 'config', 'assets',
];

const TEXT_FILES = [
    'src/components/header.ts', 'src/components/footer.ts', 'src/components/sidebar.ts',
    'src/components/nav.ts', 'src/components/breadcrumb.ts', 'src/components/modal.ts',
    'src/pages/home.ts', 'src/pages/dashboard.ts', 'src/pages/profile.ts',
    'src/pages/settings.ts', 'src/pages/login.ts', 'src/pages/register.ts',
    'src/utils/format.ts', 'src/utils/parse.ts', 'src/utils/validate.ts',
    'src/utils/helpers.ts', 'src/utils/constants.ts',
    'src/services/auth.ts', 'src/services/api.ts', 'src/services/cache.ts',
    'src/services/database.ts', 'src/services/logger.ts', 'src/services/queue.ts',
    'src/models/user.ts', 'src/models/post.ts', 'src/models/comment.ts',
    'src/models/notification.ts', 'src/models/session.ts',
    'src/middleware/cors.ts', 'src/middleware/rateLimit.ts', 'src/middleware/errorHandler.ts',
    'tests/unit/format.test.ts', 'tests/unit/parse.test.ts',
    'tests/unit/validate.test.ts', 'tests/unit/auth.test.ts',
    'tests/integration/api.test.ts', 'tests/integration/database.test.ts',
    'docs/readme.md', 'docs/api.md', 'docs/changelog.md', 'docs/contributing.md',
    'config/app.json', 'config/routes.json', 'config/database.json',
    'assets/icon.svg',
];

const BINARY_FILES = ['assets/logo.png', 'assets/banner.jpg'];

const CONVENTIONAL_PREFIXES = ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'perf', 'ci'];
const SCOPES = ['auth', 'ui', 'api', 'db', 'config', 'tests', 'docs', 'models', 'cache', 'queue'];

function git(args: string[], cwd: string, env?: Record<string, string>): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
    }).trim();
}

function makeDate(monthsFromStart: number, dayOffset: number = 0): string {
    const base = new Date(2023, 0, 1);
    base.setMonth(base.getMonth() + monthsFromStart);
    base.setDate(base.getDate() + dayOffset);
    base.setHours(10 + (dayOffset % 12), (dayOffset * 17) % 60, 0);
    return base.toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

function commitWithAuthor(
    cwd: string,
    author: Author,
    message: string,
    date: string,
): string {
    const env = {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_COMMITTER_DATE: date,
    };
    git(['add', '-A'], cwd, env);
    git(['commit', '--allow-empty', '-m', message], cwd, env);
    return git(['rev-parse', 'HEAD'], cwd);
}

function generateContent(filePath: string, version: number): string {
    const name = path.basename(filePath, path.extname(filePath));
    const lines: string[] = [];
    lines.push(`// ${name} - version ${version}`);
    lines.push(`// Auto-generated content for testing`);
    lines.push('');
    if (filePath.endsWith('.ts')) {
        lines.push(`export class ${capitalize(name)} {`);
        for (let i = 0; i < 5 + version; i++) {
            lines.push(`    method${i}(): void {`);
            lines.push(`        console.log("${name} method ${i} v${version}");`);
            lines.push(`    }`);
        }
        lines.push('}');
    } else if (filePath.endsWith('.json')) {
        lines.push(JSON.stringify({ name, version, updated: true }, null, 2));
    } else if (filePath.endsWith('.md')) {
        lines.push(`# ${capitalize(name)}`);
        lines.push('');
        lines.push(`Version ${version} documentation.`);
        for (let i = 0; i < version; i++) {
            lines.push(`- Update ${i + 1}`);
        }
    } else if (filePath.endsWith('.svg')) {
        lines.push(`<svg><text>v${version}</text></svg>`);
    }
    return lines.join('\n') + '\n';
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateMessage(index: number, files: string[]): string {
    const file = files.length > 0 ? path.basename(files[0]) : 'general';
    const r = index % 20;

    if (r < 8) {
        const prefix = CONVENTIONAL_PREFIXES[index % CONVENTIONAL_PREFIXES.length];
        const scope = SCOPES[index % SCOPES.length];
        return `${prefix}(${scope}): update ${file} with improvements #${100 + index}`;
    } else if (r < 12) {
        const body = `Improve ${file} implementation\n\nThis change updates the internal logic to handle\nedge cases better. Fixes #${200 + index}.\n\nSigned-off-by: Test Author`;
        return body;
    } else if (r < 14) {
        return `Update ${file} - handle "special" chars & <edge> cases`;
    } else if (r < 17) {
        return `fixes #${300 + index}: resolve ${file} issue`;
    } else {
        return `Update ${file} for improved performance`;
    }
}

export function createFixtureRepo(): FixtureRepo {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'glv-test-'));
    const commits: Record<string, string> = {};
    const tags: string[] = [];
    const branches: string[] = ['main'];
    const fileVersions: Record<string, number> = {};

    git(['init', '-b', 'main'], repoRoot);
    git(['config', 'user.name', 'Test'], repoRoot);
    git(['config', 'user.email', 'test@test.com'], repoRoot);

    for (const dir of DIRS) {
        fs.mkdirSync(path.join(repoRoot, dir), { recursive: true });
    }

    // --- Phase 1: Foundation (commits 1-10) ---
    const filesPerFoundationCommit = Math.ceil(TEXT_FILES.length / 8);
    for (let i = 0; i < 10; i++) {
        const author = AUTHORS[i % 2]; // Alice, Bob
        const date = makeDate(0, i);
        const start = i * filesPerFoundationCommit;
        const batch = TEXT_FILES.slice(start, start + filesPerFoundationCommit);
        for (const f of batch) {
            fileVersions[f] = 1;
            fs.writeFileSync(path.join(repoRoot, f), generateContent(f, 1));
        }
        if (i === 0) {
            for (const bf of BINARY_FILES) {
                fs.writeFileSync(path.join(repoRoot, bf), Buffer.from(Array(100).fill(i)));
                fileVersions[bf] = 1;
            }
        }
        const sha = commitWithAuthor(repoRoot, author,
            i === 0 ? 'feat: initial project setup with core files' : `feat: add batch ${i + 1} of source files`,
            date);
        commits[`foundation-${i}`] = sha;
    }

    // --- Phase 2: Early development (commits 11-50) ---
    for (let i = 0; i < 40; i++) {
        const author = AUTHORS[i % 4]; // Alice, Bob, Carol, Dave
        const date = makeDate(1 + Math.floor(i / 10), i % 28);
        const fileIdx = i % TEXT_FILES.length;
        const f = TEXT_FILES[fileIdx];
        fileVersions[f] = (fileVersions[f] || 1) + 1;
        fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
        const msg = generateMessage(10 + i, [f]);
        const sha = commitWithAuthor(repoRoot, author, msg, date);
        commits[`dev-${i}`] = sha;
    }

    // --- Phase 3: Rename refactor (commits 51-60) ---
    const renames: [string, string][] = [
        ['src/components/header.ts', 'src/components/page-header.ts'],
        ['src/services/auth.ts', 'src/services/authentication.ts'],
        ['src/services/logger.ts', 'src/services/log-service.ts'],
        ['src/middleware/cors.ts', 'src/middleware/cors-handler.ts'],
        ['src/utils/helpers.ts', 'src/utils/utility-helpers.ts'],
    ];
    for (let i = 0; i < 10; i++) {
        const author = AUTHORS[4 + (i % 2)]; // Eve, Frank
        const date = makeDate(5, i);
        if (i < renames.length) {
            const [oldPath, newPath] = renames[i];
            git(['mv', oldPath, newPath], repoRoot);
            const idx = TEXT_FILES.indexOf(oldPath);
            if (idx >= 0) TEXT_FILES[idx] = newPath;
            fileVersions[newPath] = fileVersions[oldPath] || 1;
            delete fileVersions[oldPath];
            const sha = commitWithAuthor(repoRoot, author, `refactor: rename ${path.basename(oldPath)} to ${path.basename(newPath)}`, date);
            commits[`rename-${i}`] = sha;
        } else {
            const f = TEXT_FILES[(50 + i) % TEXT_FILES.length];
            fileVersions[f] = (fileVersions[f] || 1) + 1;
            fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
            const sha = commitWithAuthor(repoRoot, author, `refactor: clean up ${path.basename(f)}`, date);
            commits[`rename-${i}`] = sha;
        }
    }

    // --- Phase 4: Cleanup (commits 61-75) ---
    const deletedFiles: string[] = [];
    for (let i = 0; i < 15; i++) {
        const author = AUTHORS[6 + (i % 2)]; // Grace, Henry
        const date = makeDate(6, i);
        if (i < 3 && TEXT_FILES.length > 40) {
            const toDelete = TEXT_FILES.pop()!;
            fs.unlinkSync(path.join(repoRoot, toDelete));
            deletedFiles.push(toDelete);
            const sha = commitWithAuthor(repoRoot, author, `chore: remove deprecated ${path.basename(toDelete)}`, date);
            commits[`cleanup-delete-${i}`] = sha;
        } else {
            const f = TEXT_FILES[i % TEXT_FILES.length];
            fileVersions[f] = (fileVersions[f] || 1) + 1;
            fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
            const sha = commitWithAuthor(repoRoot, author, generateMessage(60 + i, [f]), date);
            commits[`cleanup-${i}`] = sha;
        }
    }

    // --- Phase 5: Feature branch new-ui (commits 76-100) ---
    git(['checkout', '-b', 'feature/new-ui'], repoRoot);
    branches.push('feature/new-ui');
    const newUiFiles = ['src/components/theme-toggle.ts', 'src/components/dark-mode.ts', 'src/pages/onboarding.ts'];
    for (let i = 0; i < 25; i++) {
        const author = AUTHORS[[1, 2, 8][i % 3]]; // Bob, Carol, Iris
        const date = makeDate(7, i);
        if (i < newUiFiles.length) {
            const f = newUiFiles[i];
            fs.writeFileSync(path.join(repoRoot, f), generateContent(f, 1));
            fileVersions[f] = 1;
            TEXT_FILES.push(f);
        } else {
            const f = TEXT_FILES[i % TEXT_FILES.length];
            fileVersions[f] = (fileVersions[f] || 1) + 1;
            fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
        }
        const sha = commitWithAuthor(repoRoot, author, `feat(ui): ${i < newUiFiles.length ? 'add' : 'update'} UI component ${i + 1}`, date);
        commits[`new-ui-${i}`] = sha;
    }

    // --- Phase 6: Merge new-ui (commit 101) ---
    git(['checkout', 'main'], repoRoot);
    const mergeDate = makeDate(8, 0);
    const mergeEnv = {
        GIT_AUTHOR_NAME: AUTHORS[0].name,
        GIT_AUTHOR_EMAIL: AUTHORS[0].email,
        GIT_AUTHOR_DATE: mergeDate,
        GIT_COMMITTER_NAME: AUTHORS[0].name,
        GIT_COMMITTER_EMAIL: AUTHORS[0].email,
        GIT_COMMITTER_DATE: mergeDate,
    };
    git(['merge', 'feature/new-ui', '--no-ff', '-m', 'Merge branch feature/new-ui into main'], repoRoot, mergeEnv);
    commits['merge-new-ui'] = git(['rev-parse', 'HEAD'], repoRoot);

    // --- Phase 7: Tag v1.0 (commit 102) ---
    git(['tag', 'v1.0'], repoRoot);
    tags.push('v1.0');
    commits['tag-v1.0'] = commits['merge-new-ui'];

    // --- Phase 8: Hotfix branch (commits 103-112) ---
    git(['checkout', '-b', 'hotfix/security-patch'], repoRoot);
    branches.push('hotfix/security-patch');
    for (let i = 0; i < 10; i++) {
        const author = AUTHORS[[3, 9][i % 2]]; // Dave, Jack
        const date = makeDate(8, 5 + i);
        const f = TEXT_FILES[(i + 5) % TEXT_FILES.length];
        fileVersions[f] = (fileVersions[f] || 1) + 1;
        fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
        const sha = commitWithAuthor(repoRoot, author, `fix(security): patch vulnerability in ${path.basename(f)} #${400 + i}`, date);
        commits[`hotfix-${i}`] = sha;
    }

    // --- Phase 9: Merge hotfix (commit 113) ---
    git(['checkout', 'main'], repoRoot);
    const hotfixMergeDate = makeDate(9, 0);
    git(['merge', 'hotfix/security-patch', '--no-ff', '-m', 'Merge hotfix/security-patch: critical security patches'], repoRoot, {
        ...mergeEnv, GIT_AUTHOR_DATE: hotfixMergeDate, GIT_COMMITTER_DATE: hotfixMergeDate,
    });
    commits['merge-hotfix'] = git(['rev-parse', 'HEAD'], repoRoot);

    // --- Phase 10: Tag v1.1 (commit 114) ---
    git(['tag', 'v1.1'], repoRoot);
    tags.push('v1.1');

    // --- Phase 11: Binary files (commits 115-120) ---
    for (let i = 0; i < 6; i++) {
        const author = AUTHORS[[1, 5][i % 2]]; // Bob, Frank
        const date = makeDate(9, 5 + i);
        const bf = BINARY_FILES[i % BINARY_FILES.length];
        fs.writeFileSync(path.join(repoRoot, bf), Buffer.from(Array(200 + i * 50).fill(i + 100)));
        const sha = commitWithAuthor(repoRoot, author, `chore: update ${path.basename(bf)} binary asset`, date);
        commits[`binary-${i}`] = sha;
    }

    // --- Phase 12: Mid-life development (commits 121-200) ---
    for (let i = 0; i < 80; i++) {
        const author = AUTHORS[i % 10];
        const date = makeDate(9 + Math.floor(i / 20), i % 28);
        const fileCount = 1 + (i % 3);
        const touchedFiles: string[] = [];
        for (let j = 0; j < fileCount; j++) {
            const f = TEXT_FILES[(i * 3 + j) % TEXT_FILES.length];
            fileVersions[f] = (fileVersions[f] || 1) + 1;
            fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
            touchedFiles.push(f);
        }
        const sha = commitWithAuthor(repoRoot, author, generateMessage(120 + i, touchedFiles), date);
        commits[`midlife-${i}`] = sha;
    }

    // --- Phase 13: Revert (commit 201) ---
    // Add a standalone file then revert it to avoid conflicts
    const revertDate = makeDate(13, 0);
    const revertAuthor = AUTHORS[2]; // Carol
    const revertFile = 'src/utils/deprecated-feature.ts';
    fs.writeFileSync(path.join(repoRoot, revertFile), generateContent(revertFile, 1));
    const revertTargetSha = commitWithAuthor(repoRoot, revertAuthor, 'feat: add deprecated feature (to be reverted)', revertDate);
    commits['pre-revert'] = revertTargetSha;

    const revertEnv = {
        GIT_AUTHOR_NAME: revertAuthor.name,
        GIT_AUTHOR_EMAIL: revertAuthor.email,
        GIT_AUTHOR_DATE: makeDate(13, 1),
        GIT_COMMITTER_NAME: revertAuthor.name,
        GIT_COMMITTER_EMAIL: revertAuthor.email,
        GIT_COMMITTER_DATE: makeDate(13, 1),
    };
    git(['revert', '--no-edit', revertTargetSha], repoRoot, revertEnv);
    commits['revert'] = git(['rev-parse', 'HEAD'], repoRoot);

    // --- Phase 14: Feature branch api-v2 (commits 202-230) ---
    git(['checkout', '-b', 'feature/api-v2'], repoRoot);
    branches.push('feature/api-v2');
    for (let i = 0; i < 29; i++) {
        const author = AUTHORS[[3, 4, 7][i % 3]]; // Dave, Eve, Henry
        const date = makeDate(13, 5 + i);
        const f = TEXT_FILES[(i + 10) % TEXT_FILES.length];
        fileVersions[f] = (fileVersions[f] || 1) + 1;
        fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
        const sha = commitWithAuthor(repoRoot, author, `feat(api): implement v2 endpoint for ${path.basename(f)}`, date);
        commits[`api-v2-${i}`] = sha;
    }

    // --- Phase 15: Merge api-v2 (commit 231) ---
    git(['checkout', 'main'], repoRoot);
    const apiMergeDate = makeDate(15, 0);
    git(['merge', 'feature/api-v2', '--no-ff', '-m', 'Merge feature/api-v2: complete API v2 migration'], repoRoot, {
        ...mergeEnv, GIT_AUTHOR_DATE: apiMergeDate, GIT_COMMITTER_DATE: apiMergeDate,
    });
    commits['merge-api-v2'] = git(['rev-parse', 'HEAD'], repoRoot);

    // --- Phase 16: Tag v2.0 (commit 232) ---
    git(['tag', 'v2.0'], repoRoot);
    tags.push('v2.0');

    // --- Phase 17: Feature branch perf (commits 233-250) ---
    git(['checkout', '-b', 'feature/performance'], repoRoot);
    branches.push('feature/performance');
    for (let i = 0; i < 18; i++) {
        const author = AUTHORS[[5, 6, 9][i % 3]]; // Frank, Grace, Jack
        const date = makeDate(15, 5 + i);
        const f = TEXT_FILES[(i + 20) % TEXT_FILES.length];
        fileVersions[f] = (fileVersions[f] || 1) + 1;
        fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
        const sha = commitWithAuthor(repoRoot, author, `perf: optimize ${path.basename(f)} for better throughput`, date);
        commits[`perf-${i}`] = sha;
    }

    // --- Phase 18: Merge perf (commit 251) ---
    git(['checkout', 'main'], repoRoot);
    const perfMergeDate = makeDate(16, 0);
    git(['merge', 'feature/performance', '--no-ff', '-m', 'Merge feature/performance: performance improvements'], repoRoot, {
        ...mergeEnv, GIT_AUTHOR_DATE: perfMergeDate, GIT_COMMITTER_DATE: perfMergeDate,
    });
    commits['merge-perf'] = git(['rev-parse', 'HEAD'], repoRoot);

    // --- Phase 19: Tag v2.1 (commit 252) ---
    git(['tag', 'v2.1'], repoRoot);
    tags.push('v2.1');

    // --- Phase 20: Late development (commits 253-300) ---
    for (let i = 0; i < 48; i++) {
        const author = AUTHORS[i % 10];
        const date = makeDate(16 + Math.floor(i / 24), i % 28);
        const f = TEXT_FILES[(i * 2) % TEXT_FILES.length];
        fileVersions[f] = (fileVersions[f] || 1) + 1;
        fs.writeFileSync(path.join(repoRoot, f), generateContent(f, fileVersions[f]));
        const sha = commitWithAuthor(repoRoot, author, generateMessage(252 + i, [f]), date);
        commits[`late-${i}`] = sha;
    }

    const allFiles = [...TEXT_FILES, ...BINARY_FILES];

    return {
        repoRoot,
        commits,
        tags,
        branches,
        files: allFiles,
        authors: AUTHORS,
        cleanup: () => {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        },
    };
}
