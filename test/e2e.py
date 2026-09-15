"""Real browser -> HTTP/SSE -> queue -> INSTALLED recorder integration test.

Requires Python Playwright and Chromium. Does not launch Codex or bypass Hook trust.
Fails (never silently mocks/skips) if the environment forbids local navigation.
CHROMIUM_PATH=/usr/bin/chromium python test/e2e.py
"""
import asyncio
import json
import hashlib
import os
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright, expect

ROOT = Path(__file__).resolve().parents[1]

async def main():
    with tempfile.TemporaryDirectory(prefix='town-e2e-') as directory:
        data = Path(directory) / 'data'
        codex = Path(directory) / 'codex'
        env = {**os.environ, 'TOWN_DATA_DIR': str(data), 'CODEX_HOME': str(codex)}
        token = 'e2e-viewer-token-not-a-real-credential'
        async def run(*args, input_bytes=None):
            p = await asyncio.create_subprocess_exec(*args, cwd=ROOT, env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await asyncio.wait_for(p.communicate(input_bytes), timeout=10)
            assert p.returncode == 0, err.decode()
            return out, err
        data.mkdir(parents=True)
        task_id=hashlib.sha256(b'e2e-task').hexdigest()[:20]
        project_id=hashlib.sha256(b'/example/project').hexdigest()[:20]
        (data/'labels.json').write_text(json.dumps({'version':1,'tasks':{task_id:'修复登录权限'},'projects':{project_id:'青山后台'}}))
        await run('node', 'scripts/setup.mjs', '--write')
        hooks = json.loads((codex / 'hooks.json').read_text())['hooks']
        async def emit(event, session='e2e-task', **extra):
            payload = {'hook_event_name': event, 'session_id': session, 'turn_id': 'round-1',
                'cwd': '/example/project', **extra}
            command = hooks[event][-1]['hooks'][0]['command']
            out, err = await run('/bin/sh', '-c', command, input_bytes=json.dumps(payload).encode())
            assert not out and not err, 'Recorder must be silent'
        js = """import {startServer} from './src/start.mjs';
        const app=await startServer({port:0,dataDir:process.env.TOWN_DATA_DIR,pollMs:50,
          staleMs:2500,token:'e2e-viewer-token-not-a-real-credential'});
        console.log(JSON.stringify({port:app.address.port}));
        process.on('SIGTERM',async()=>{await app.close();process.exit(0)});"""
        server = await asyncio.create_subprocess_exec('node', '--input-type=module', '-e', js,
            cwd=ROOT, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            line = await asyncio.wait_for(server.stdout.readline(), timeout=10)
            port = json.loads(line)['port']
            base = f'http://127.0.0.1:{port}'
            async with async_playwright() as p:
                browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'),
                    headless=True, args=['--no-sandbox'])
                try:
                    page = await browser.new_page(viewport={'width':1440,'height':1100})
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    response = await page.goto(base, wait_until='domcontentloaded')
                    assert response.status == 200
                    assert "script-src 'self'" in response.headers['content-security-policy']
                    # Retry DOM assertions without string-eval polling: real CSP stays strict.
                    await expect(page.locator('#connection')).to_have_text('需要查看令牌')
                    await page.locator('#guide').click()
                    await page.locator('#viewer-token').fill(token)
                    await page.locator('#save-token').click()
                    await expect(page.locator('#connection')).to_contain_text('在线')
                    assert await page.locator('.resident').count() == 0
                    await run('node', 'scripts/probe.mjs')
                    await expect(page.locator('#reference-count')).to_have_text('1')
                    await expect(page.locator('#total')).to_have_text('0')
                    await page.locator('[data-filter=reference]').click()
                    await expect(page.locator('.name').first).to_contain_text('[自检]')
                    await page.locator('[data-filter=all]').click()
                    assert '尚无非探针事件' in await page.locator('#footer-status').inner_text()
                    await emit('UserPromptSubmit', prompt='前端 design-do-not-expose-this-prompt')
                    await emit('PreToolUse', tool_name='apply_patch', tool_use_id='edit-a',
                        tool_input={'command':'*** Update File: /example/project/private.tsx'})
                    await page.wait_for_selector('.resident.state-coding')
                    await expect(page.locator('.task-card.category-active .roster-name')).to_have_text('修复登录权限')
                    await expect(page.locator('#working')).to_have_text('1')
                    await expect(page.locator('.task-card.category-active .roster-project')).to_contain_text('青山后台')
                    await expect(page.locator('#task-list')).to_be_visible()
                    await emit('UserPromptSubmit', session='second-task', prompt='数据库')
                    await emit('PermissionRequest', session='second-task', tool_name='Bash',
                        tool_input={'description':'approval reason', 'command':'npm test'})
                    await page.wait_for_selector('.state-waiting')
                    await emit('PostToolUse', session='second-task', tool_name='Bash', tool_use_id='test-a',
                        tool_input={'command':'npm test'}, tool_response={'exit_code':0})
                    await expect(page.locator('.state-waiting')).to_have_count(0)
                    snapshot = await page.evaluate("async()=>await (await fetch('/api/snapshot',{headers:{Authorization:'Bearer '+sessionStorage.getItem('task-town-token')}})).json()")
                    serialized = json.dumps(snapshot)
                    assert 'design-do-not-expose' not in serialized
                    assert '/example/project' not in serialized
                    assert snapshot['realEventCount'] == 5
                    assert any(t['synthetic'] for t in snapshot['tasks'])
                    # This wait is intentional: live HTTP remains open, but a task's
                    # evidence must expire WITHOUT waiting for the next SSE heartbeat.
                    await expect(page.locator('.state-coding,.state-thinking')).to_have_count(0, timeout=7000)
                    await page.set_viewport_size({'width':390,'height':844})
                    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth')
                    await expect(page.locator('.task-row')).to_have_count(2)
                    await emit('SubagentStart', agent_id='child-a')
                    await expect(page.locator('#children-count')).to_have_text('1')
                    await expect(page.locator('#total')).to_have_text('2')
                    await expect(page.locator('.category-children .roster-project')).to_contain_text('属于 修复登录权限')
                    await emit('SubagentStop', agent_id='child-a')
                    await expect(page.locator('#children-count')).to_have_text('0')
                    await expect(page.locator('#history-count')).to_have_text('1')
                    await emit('SessionEnd')
                    await expect(page.locator('#total')).to_have_text('1')
                    await expect(page.locator('#history-count')).to_have_text('2')
                    await expect(page.locator('.task-row')).to_have_count(1)
                    assert not errors, errors
                    print(json.dumps({'real_browser_server_e2e':True, 'installed_recorder_executed':True,
                        'real_desktop_hooks_tested':False, 'console_errors':errors,
                        'checks':['real CSP and ES modules','viewer authentication','synthetic provenance',
                            'two task isolation','ID-less approval resolution','privacy','client-side expiry','mobile layout','shared labels from disk','desktop worklist','probe excluded from count','closed tasks archived','children do not inflate total']}, indent=2))
                finally:
                    await browser.close()
        finally:
            if server.returncode is None:
                server.terminate()
                try: await asyncio.wait_for(server.wait(), timeout=10)
                except asyncio.TimeoutError:
                    server.kill()
                    await server.wait()

if __name__ == '__main__':
    asyncio.run(main())
