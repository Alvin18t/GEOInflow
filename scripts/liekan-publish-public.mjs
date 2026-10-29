import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPublicHistory, git, readPolicy } from './liekan-public-history.mjs';

function ancestor(repo, older, newer) {
  try {
    git(repo, ['merge-base', '--is-ancestor', older, newer]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function refExists(repo, ref) {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', ref]);
  } catch (error) {
    if (error.status === 1 || error.status === 128) return null;
    throw error;
  }
}

export function preparePublicPublication({
  source = process.cwd(),
  target,
  sourceRef = 'HEAD',
  branch,
  policy = readPolicy(),
}) {
  if (!target) throw new Error('Provide an independent public checkout with --target');
  source = realpathSync(source);
  target = realpathSync(target);
  if (source === target)
    throw new Error('Source and public checkout must be separate repositories');
  if (!branch?.startsWith('feature/'))
    throw new Error('Publication branch must start with feature/');
  git(target, ['check-ref-format', '--branch', branch]);
  if (sourceRef.startsWith('-')) throw new Error('Invalid source reference');
  const targetGitDir = realpathSync(git(target, ['rev-parse', '--absolute-git-dir']));
  if (
    targetGitDir !== realpathSync(join(target, '.git')) ||
    git(target, ['rev-parse', '--git-common-dir']) !== '.git'
  )
    throw new Error('Public checkout must have its own independent Git directory');
  if (
    realpathSync(git(source, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ===
    targetGitDir
  )
    throw new Error('Source and public checkout share Git history storage');
  if (git(target, ['status', '--porcelain=v1', '-uall']))
    throw new Error('Public checkout has local changes');
  if (git(target, ['branch', '--show-current']) === branch)
    throw new Error('Keep the public checkout on main while preparing a feature branch');
  if (
    git(target, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .includes(`branch refs/heads/${branch}`)
  )
    throw new Error('Publication branch is checked out in another worktree');
  const remotes = git(target, ['remote']).split('\n');
  if (remotes.length !== 1 || remotes[0] !== 'origin')
    throw new Error('Public checkout must have only its GitHub origin remote');
  for (const kind of [[], ['--push']]) {
    const urls = git(target, ['remote', 'get-url', ...kind, '--all', 'origin']).split('\n');
    if (urls.length !== 1 || urls[0] !== policy.repository)
      throw new Error('Public origin does not match the approved GitHub repository');
  }
  const localRefs = git(target, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ])
    .split('\n')
    .filter(Boolean);
  checkPublicHistory({ repo: target, refs: localRefs.length ? localRefs : ['HEAD'], policy });
  const main = git(target, ['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  const remoteMain = refExists(target, 'refs/remotes/origin/main');
  if (!remoteMain || main !== remoteMain)
    throw new Error('Public main must match origin/main; fetch and fast-forward main first');
  const ref = `refs/heads/${branch}`;
  const previous = refExists(target, ref);
  let parent = previous || main;
  if (!ancestor(target, main, parent)) {
    if (ancestor(target, parent, main)) parent = main;
    else
      throw new Error(
        'Public candidate does not contain origin/main; reconcile it before publication',
      );
  }
  const sourceCommit = git(source, ['rev-parse', '--verify', `${sourceRef}^{commit}`]);
  const sourceTree = git(source, ['rev-parse', `${sourceCommit}^{tree}`]);
  if (
    git(source, ['ls-tree', '-r', sourceCommit])
      .split('\n')
      .some(line => line.startsWith('160000 '))
  )
    throw new Error('Publication requires materialized source files; submodules are unsupported');
  if (git(target, ['rev-parse', `${parent}^{tree}`]) === sourceTree)
    return { changed: false, branch, commit: parent, sourceCommit, tree: sourceTree };
  const records = git(target, [
    'log',
    '--topo-order',
    '--format=%H',
    '--fixed-strings',
    '--grep=GEOInflow-Source-Revision:',
    parent,
  ])
    .split('\n')
    .filter(Boolean);
  let published;
  for (const record of records) {
    const text = git(target, ['show', '-s', '--format=%B', record]);
    const revisions = [...text.matchAll(/^GEOInflow-Source-Revision: ([a-f0-9]{40})$/gm)];
    const trees = [...text.matchAll(/^GEOInflow-Source-Tree: ([a-f0-9]{40})$/gm)];
    if (revisions.length !== 1 || trees.length !== 1) continue;
    const sourceRevision = refExists(source, `${revisions[0][1]}^{commit}`);
    if (!sourceRevision) continue;
    const actual = git(source, ['rev-parse', `${sourceRevision}^{tree}`]);
    if (actual !== trees[0][1] || actual !== git(target, ['rev-parse', `${record}^{tree}`]))
      continue;
    if (!ancestor(source, sourceRevision, sourceCommit))
      throw new Error('Source must descend from the previously published development revision');
    published = record;
    break;
  }
  if (!published) {
    if (!ancestor(target, policy.baseline, parent))
      throw new Error('No recognized public publication baseline');
    published = policy.baseline;
  }
  const temporary = mkdtempSync(join(tmpdir(), 'geoinflow-publication-'));
  try {
    const files = join(temporary, 'files');
    mkdirSync(files);
    const archive = join(temporary, 'source.tar');
    git(source, ['archive', '--format=tar', `--output=${archive}`, sourceCommit]);
    execFileSync('tar', ['-xf', archive, '-C', files]);
    const indexEnv = { GIT_INDEX_FILE: join(temporary, 'index') };
    git(target, ['read-tree', '--empty'], { env: indexEnv });
    git(
      files,
      [
        '--git-dir',
        targetGitDir,
        '--work-tree',
        files,
        '-c',
        'core.filemode=true',
        '-c',
        'core.autocrlf=false',
        'add',
        '--all',
        '--force',
        '--',
        '.',
      ],
      { env: indexEnv },
    );
    const tree = git(target, ['write-tree'], { env: indexEnv });
    if (tree !== sourceTree)
      throw new Error('Exported files differ from the committed source tree');
    const message = `chore: publish verified GEOInflow source\n\nGEOInflow-Source-Revision: ${sourceCommit}\nGEOInflow-Source-Tree: ${tree}\n`;
    const proposed = git(target, ['commit-tree', tree, '-p', published], { input: message });
    let mergedTree;
    try {
      mergedTree = git(target, ['merge-tree', '--write-tree', parent, proposed]).split('\n')[0];
    } catch (error) {
      if (error.status === 1)
        throw new Error(
          'Public changes conflict with the source; synchronize them into development first',
        );
      throw error;
    }
    if (mergedTree !== sourceTree)
      throw new Error(
        'Public changes are absent from the source; synchronize them into development first',
      );
    const commit = git(target, ['commit-tree', tree, '-p', parent], { input: message });
    checkPublicHistory({ repo: target, refs: [commit], policy });
    if (
      git(target, ['rev-parse', 'refs/heads/main']) !== main ||
      git(target, ['status', '--porcelain=v1', '-uall'])
    )
      throw new Error('Public checkout changed while preparing the candidate');
    if (git(target, ['worktree', 'list', '--porcelain']).split('\n').includes(`branch ${ref}`))
      throw new Error('Publication branch became checked out while preparing the candidate');
    git(target, ['update-ref', ref, commit, previous || '0'.repeat(40)]);
    return { changed: true, branch, commit, parent, sourceCommit, tree };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--help') {
        console.log(
          'Usage: node scripts/liekan-publish-public.mjs --target DIR --branch feature/NAME [--source-ref REF]',
        );
        console.log(
          'Prepares a local commit from tracked source files. Push the feature branch normally and merge through a checked GitHub pull request.',
        );
        process.exit(0);
      }
      const key = { '--target': 'target', '--branch': 'branch', '--source-ref': 'sourceRef' }[
        args[i]
      ];
      if (!key) throw new Error(`Unknown option: ${args[i]}`);
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error(`Missing value for ${args[i - 1]}`);
      options[key] = value;
    }
    console.log(JSON.stringify(preparePublicPublication(options)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
