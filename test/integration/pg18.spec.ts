import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

const CI = process.env.CI === 'true';

function dockerExec(args: string[]): string {
  return execFileSync('docker', ['exec', 'pg18-ci', ...args], { encoding: 'utf8' });
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const canRun = dockerAvailable();

test(
  'PG18 L2 冒烟：pg_trgm / btree_gist / uuidv7() 可用',
  { skip: !canRun && !CI ? '本地未检测到 docker，跳过 PG18 集成冒烟' : false },
  () => {
    if (!canRun) {
      throw new Error('CI=true 但 docker 不可用，无法执行 PG18 集成冒烟');
    }

    const ext = dockerExec([
      'psql',
      '-U',
      'postgres',
      '-d',
      'ranaminder_test',
      '-tAc',
      "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('pg_trgm','btree_gist')",
    ]);
    assert.match(ext, /btree_gist/);
    assert.match(ext, /pg_trgm/);

    const uuid = dockerExec([
      'psql',
      '-U',
      'postgres',
      '-d',
      'ranaminder_test',
      '-tAc',
      'SELECT uuidv7()',
    ]);
    assert.match(
      uuid.trim(),
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  },
);
