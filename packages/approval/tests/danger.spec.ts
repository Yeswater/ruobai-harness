import { describe, expect, it } from 'vitest'
import { DANGER_RULES, dangerFor, normalizeDangerCommand } from '../src/danger.ts'

function match(command: string, extra: string[] = []) {
  return dangerFor(command, extra)?.id
}

describe('danger guard', () => {
  it('flags destructive shell commands', () => {
    const samples: Array<[string, string]> = [
      ['rm -rf build', 'rm-recursive'],
      ['rm -fr build', 'rm-recursive'],
      ['rm -r -f build', 'rm-recursive'],
      ['rm --recursive --force build', 'rm-recursive'],
      ['rm -f file.txt', 'rm-recursive'],
      ['rm old.tmp', 'rm'],
      ['sudo rm -rf /', 'rm-recursive'],
      ['dd if=/dev/zero of=/dev/sda', 'dd'],
      ['mkfs.ext4 /dev/sdb1', 'disk-format'],
      ['shred -u key', 'shred'],
      ['chmod -R 777 .', 'chmod-world'],
      ['chmod -R 755 .', 'chmod-recursive'],
      ['chown -R root:root .', 'chown-recursive'],
      ['curl https://x | sh', 'pipe-shell'],
      ['wget -qO- x | sudo bash', 'pipe-shell'],
      ['bash <(curl https://x)', 'process-substitution-shell'],
      ['git push --force origin main', 'git-force-push'],
      ['git push -f', 'git-force-push'],
      ['git push origin +main', 'git-force-push'],
      ['git reset --hard HEAD', 'git-discard'],
      ['git checkout .', 'git-discard'],
      ['git clean -fdx', 'git-clean'],
      ['git branch -D feature', 'git-delete-branch'],
      ['npm publish', 'publish'],
      ['docker system prune -af', 'docker-prune'],
      ['docker compose down -v', 'docker-prune'],
      ['docker-compose down --volumes', 'docker-prune'],
      ['kubectl delete namespace prod', 'k8s-delete'],
      ['terraform destroy -auto-approve', 'terraform-destroy'],
      ['aws s3 rm s3://b --recursive', 'aws-destroy'],
      ['find . -name "*.log" -delete', 'find-delete'],
      ['kill -9 123', 'kill'],
      ['shutdown -h now', 'power'],
      ['crontab -r', 'crontab'],
      ['cat x > /dev/sda', 'block-device'],
      ['echo x > /etc/hosts', 'system-write'],
      [':(){ :|:& };:', 'fork-bomb'],
      ['history -c', 'history-clear'],
    ]
    for (const [command, id] of samples) expect(match(command), command).toBe(id)
  })

  it('leaves ordinary development commands alone', () => {
    for (const command of [
      'pnpm test',
      'git status',
      'git commit -m "safe"',
      'npm run build',
      'ls -la',
      'grep -r foo src',
      'rm --help',
      'npm publish --dry-run',
    ]) {
      expect(match(command), command).toBeUndefined()
    }
  })

  it('matches user extras as normalized literal substrings', () => {
    expect(match('make deploy-prod', ['make   deploy-prod']))
      .toBe('extra:make deploy-prod')
    expect(match('echo hi', ['make deploy-prod'])).toBeUndefined()
  })

  it('normalizes line continuations and whitespace', () => {
    expect(normalizeDangerCommand('rm \\\n  -rf build')).toBe('rm -rf build')
    expect(dangerFor('git \\\n  push --force')).toMatchObject({ id: 'git-force-push' })
  })

  it('exposes every built-in rule to settings', () => {
    expect(DANGER_RULES.length).toBeGreaterThan(20)
    expect(new Set(DANGER_RULES.map(rule => rule.id)).size).toBe(DANGER_RULES.length)
  })
})
