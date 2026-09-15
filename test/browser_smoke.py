"""In-memory browser UI tests. Mocked transport, not Codex Desktop or browser/server E2E.

Requires Python Playwright and Chromium. Real HTTP/SSE/storage are tested by npm test.
CHROMIUM_PATH=/usr/bin/chromium TOWN_SCREENSHOT_DIR=/tmp python test/browser_smoke.py
"""
import asyncio
import base64
import json
import os
import re
import tempfile
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    output = Path(os.environ.get('TOWN_SCREENSHOT_DIR', tempfile.gettempdir()))
    output.mkdir(parents=True, exist_ok=True)
    root = Path(__file__).resolve().parents[1] / 'public'
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH'), headless=True, args=['--no-sandbox'])
        page = await browser.new_page(viewport={'width':1440,'height':1100}, device_scale_factor=1)
        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
        # A self-contained fixture, not a workaround for browser navigation policy.
        html=(root/'index.html').read_text()
        html=re.sub(r'<script[^>]+src="/app.js"[^>]*></script>','',html)
        html=re.sub(r'<link[^>]+>','',html)
        svg=base64.b64encode((root/'favicon.svg').read_bytes()).decode()
        html=html.replace('src="/favicon.svg"','src="data:image/svg+xml;base64,'+svg+'"')
        await page.set_content(html)
        await page.add_style_tag(content=(root/'styles.css').read_text())
        await page.add_script_tag(content="""
          history.replaceState=()=>{};
          window.mockRequests=[];
          window.mockSnapshot={tasks:[],serverTime:Date.now(),eventCount:0,lastHookAt:0,staleMs:120000};
          window.feedSnapshot=s=>{
            window.mockSnapshot=s;
            if(window.mockController) window.mockController.enqueue(new TextEncoder().encode('event: snapshot\\ndata: '+JSON.stringify(s)+'\\n\\n'));
          };
          window.fetch=async (url,options={})=>{
            window.mockRequests.push({url,headers:options.headers});
            return new Response(new ReadableStream({start(controller){
              window.mockController=controller;
              controller.enqueue(new TextEncoder().encode('event: snapshot\\ndata: '+JSON.stringify(window.mockSnapshot)+'\\n\\n'));
              options.signal?.addEventListener('abort',()=>{try{controller.error(new Error('aborted'));}catch{}});
            }}),{headers:{'Content-Type':'text/event-stream'}});
          };
        """)
        parts=[]
        for name in ['layout.js','scene.js','app.js']:
            js=(root/name).read_text()
            js=re.sub(r'^import .*?;\n','',js,flags=re.M)
            js=js.replace('export ','')
            if name=='app.js':js=js.replace('setMode(mode);',"setMode('demo');")
            parts.append(js)
        await page.add_script_tag(content='\n'.join(parts))
        await page.wait_for_selector('.resident')
        await page.wait_for_timeout(300)
        await page.screenshot(path=str(output/'task-town-studio-desktop.png'),full_page=True)
        assert await page.locator('.resident').count()==8
        assert not await page.locator('#detail-dialog').is_visible()
        initial=await page.locator('.resident').nth(2).get_attribute('style')
        await page.get_by_role('button',name='工作中',exact=True).click()
        assert await page.locator('.resident').count()==5
        assert await page.locator('.resident').nth(2).get_attribute('style')==initial
        await page.get_by_role('button',name='等待 / 未知',exact=True).click()
        assert await page.locator('.resident').count()==1
        await page.get_by_role('button',name='当前',exact=True).click()
        await page.locator('#search').fill('后台');assert await page.locator('.resident').count()==1
        await page.locator('#search').fill('')
        await page.locator('.resident').first.click()
        assert await page.locator('#detail-dialog').is_visible()
        await page.locator('#rename').click();await page.locator('#nickname').fill('<img src=x onerror=alert(1)>')
        await page.locator('#role-select').select_option('docs');await page.locator('#save-name').click()
        assert '<img src=x' in await page.locator('#detail-title').inner_text()
        assert await page.locator('#detail-title img').count()==0
        await page.locator('#rename').click();await page.locator('#nickname').fill('')
        await page.locator('#role-select').select_option('');await page.locator('#save-name').click()
        await page.keyboard.press('Escape')
        await page.locator('#animation').click();assert await page.locator('#animation').get_attribute('aria-pressed')=='true'
        before=await page.locator('#town').evaluate('(c)=>c.toDataURL()');await page.wait_for_timeout(400)
        after=await page.locator('#town').evaluate('(c)=>c.toDataURL()');assert before==after
        await page.locator('#animation').click()
        await page.locator('#guide').click();await page.locator('#viewer-token').fill('example-viewer-token')
        await page.locator('#save-token').click()
        await page.wait_for_function("document.querySelector('#connection').textContent.includes('在线')")
        assert await page.locator('.resident').count()==0
        frame=await page.evaluate('scene.frame');await page.wait_for_timeout(350)
        assert frame==await page.evaluate('scene.frame'), 'empty town should not run an animation timer'
        requests=await page.evaluate('window.mockRequests')
        assert requests[-1]['url']=='/api/events'
        assert requests[-1]['headers']['Authorization']=='Bearer example-viewer-token'
        await page.evaluate("""feedSnapshot({serverTime:Date.now(),eventCount:20,lastHookAt:Date.now(),staleMs:120000,tasks:
          Array.from({length:20},(_,i)=>({id:'fixture-'+i,role:'frontend',title:'任务 '+i,state:'coding',displayState:'coding',
          summary:'正在修改代码',createdAt:Date.now()+i,lastAt:Date.now(),history:[]}))})""")
        await page.wait_for_function("document.querySelector('#total').textContent==='20'")
        assert await page.locator('.resident').count()==8
        assert await page.locator('#page-label').inner_text()=='1 / 3'
        await page.locator('#next').click();assert await page.locator('#page-label').inner_text()=='2 / 3'
        await page.locator('#next').click();assert await page.locator('.resident').count()==4
        # Residents in different logical rooms must not be packed together on search.
        await page.locator('#previous').click();await page.locator('#previous').click()
        place0=await page.locator('.resident').first.get_attribute('style')
        await page.locator('#search').fill('任务 1')
        assert await page.locator('.resident').count()==1
        await page.locator('#search').fill('任务 0')
        assert await page.locator('.resident').first.get_attribute('style')==place0
        await page.locator('#search').fill('')
        await page.locator('.resident').first.click();await page.locator('#rename').click()
        await page.evaluate('feedSnapshot({...mockSnapshot,tasks:mockSnapshot.tasks.slice(1)})')
        assert not await page.locator('#rename-dialog').is_visible(), 'removed task must not leave a live rename target'
        await page.evaluate('feedSnapshot({...mockSnapshot,tasks:[null]})')
        await page.wait_for_function("document.querySelector('#connection').textContent.includes('中断')")
        assert await page.locator('#total').inner_text()=='19', 'invalid frame must not replace last good data'
        # Four synthetic fixture workers span three rooms; one probe must not inflate the count.
        await page.evaluate('mockSnapshot={tasks:[],serverTime:Date.now(),eventCount:0,lastHookAt:0,staleMs:120000}')
        await page.locator('#live-mode').click()
        await page.wait_for_function("document.querySelector('#connection').textContent.includes('在线')")
        await page.evaluate("""feedSnapshot({serverTime:Date.now(),eventCount:17,lastHookAt:Date.now(),staleMs:120000,tasks:
          Array.from({length:17},(_,i)=>({id:'roster-'+i,
          role:({0:'backend',5:'frontend',10:'testing',16:'docs'})[i]||'general',
          title:({0:'修复登录权限',5:'优化侧边导航',10:'回归权限测试',16:'整理接口文档'})[i]||'参考任务 '+i,
          titleSource:'shared',projectLabel:'青山后台',
          state:({0:'coding',5:'coding',10:'testing',16:'reading'})[i]||'review',
          displayState:({0:'coding',5:'coding',10:'testing',16:'reading'})[i]||'review',
          summary:({0:'正在修改鉴权逻辑',5:'正在调整导航组件',10:'正在运行权限测试',16:'正在核对接口说明'})[i]||'本轮收尾',
          createdAt:Date.now()+i,lastAt:Date.now(),history:[]})).concat([
          {id:'probe-only',role:'testing',title:'探针',state:'testing',displayState:'testing',synthetic:true,
          summary:'正在运行测试',createdAt:Date.now(),lastAt:Date.now(),history:[]}])})""")
        await page.wait_for_function("document.querySelector('#working').textContent==='4'")
        assert await page.locator('.task-card.category-active').count()==4
        assert await page.locator('.task-card.category-reference').count()==0
        assert await page.locator('#reference-count').inner_text()=='1'
        assert await page.locator('#total').inner_text()=='17'
        assert await page.locator('#task-list').is_visible(), 'worklist must be visible on desktop'
        # No click, hover, filter or motion required: all four active cards are above the fold.
        await page.locator('#animation').click()
        await page.evaluate('window.scrollTo(0,0)')
        await page.screenshot(path=str(output/'four-before-check.png'),full_page=True)
        boxes = await page.locator('.task-card.category-active').evaluate_all('(xs)=>xs.map(x=>{let r=x.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight}})')
        assert all(b['top'] >= 0 and b['bottom'] <= b['height'] for b in boxes), boxes
        assert await page.locator('.task-card.category-active .roster-action').evaluate_all('(xs)=>xs.every(x=>x.textContent&&x.scrollHeight<=x.clientHeight+1)')
        await page.locator('#animation').click()
        await page.locator('#search').fill('no-match')
        await page.locator('[data-scope=active]').click()
        assert await page.locator('#search').input_value()==''
        assert await page.locator('.task-row').count()==4
        assert await page.locator('#task-list').evaluate('(el)=>{const cards=el.querySelectorAll(".task-card");return cards[3].getBoundingClientRect().bottom<=el.getBoundingClientRect().bottom}'), 'all four workers should fit in the desktop list'
        stamp=await page.add_style_tag(content='body::after{content:"界面回归测试示例 · 非线上真实任务";position:fixed;bottom:10px;right:20px;background:#fff7df;border:1px solid #cdb882;padding:10px;z-index:9999;font-size:12px;color:#735322}')
        await page.screenshot(path=str(output/'task-town-four-workers.png'),full_page=True)
        await stamp.evaluate('(el)=>el.remove()')
        assert await page.locator('#page-label').inner_text()=='1 / 3'
        last=page.locator('.task-row').last
        await last.click()
        assert not await page.locator('#detail-dialog').is_visible(), 'locating must not cover the scene'
        assert await page.locator('#page-label').inner_text()=='3 / 3'
        assert await page.locator('.resident.selected .resident-number').inner_text()=='17'
        assert await page.locator('.resident.selected .resident-state').inner_text()=='● 阅读中'
        assert await page.locator('.task-card.selected .roster-number').inner_text()=='17'
        await last.focus();await page.wait_for_timeout(1100)
        assert await last.evaluate('(el)=>document.activeElement===el'), 'age updates must preserve keyboard focus'
        await page.locator('.task-details').last.click()
        assert await page.locator('#detail-title').inner_text()=='整理接口文档'
        await page.keyboard.press('Escape')
        await page.locator('[data-scope=all]').click()
        await page.locator('#search').fill('青山后台')
        assert await page.locator('.task-row').count()==17
        await page.locator('#search').fill('')
        await page.locator('[data-scope=active]').click()
        # Force stale timestamps through the real presentation code, not just CSS.
        await page.evaluate('feedSnapshot({...mockSnapshot,serverTime:Date.now(),tasks:mockSnapshot.tasks.map(t=>({...t,lastAt:Date.now()-130000}))})')
        await page.wait_for_function("document.querySelector('#working').textContent==='0'")
        assert await page.locator('.task-row').count()==0
        await page.locator('[data-scope=waiting]').click()
        assert await page.locator('.task-row').count()==17
        assert '上次：' in await page.locator('.roster-action').first.inner_text()
        await page.locator('[data-scope=all]').click()
        await page.evaluate('feedSnapshot({...mockSnapshot,serverTime:Date.now(),tasks:mockSnapshot.tasks.map(t=>({...t,lastAt:Date.now()-1800001}))})')
        await page.wait_for_function("document.querySelector('#total').textContent==='0'")
        assert await page.locator('.task-row').count()==0
        assert await page.locator('#history-count').inner_text()=='17'
        await page.locator('[data-filter=archived]').click()
        assert await page.locator('.task-row').count()==17
        assert '上次：' in await page.locator('.roster-action').first.inner_text()
        await page.locator('[data-filter=all]').click()
        await page.evaluate("""feedSnapshot({serverTime:Date.now(),eventCount:9,lastHookAt:Date.now(),tasks:[
          {id:'parent',role:'backend',title:'一个主任务',state:'coding',summary:'正在修改代码',lastAt:Date.now(),createdAt:Date.now(),history:[]},
          {id:'child',parentTaskId:'parent',role:'testing',title:'子任务',state:'testing',summary:'正在测试',lastAt:Date.now(),createdAt:Date.now(),history:[]},
          {id:'closed',role:'docs',title:'已关闭任务',state:'ended',summary:'会话关闭',lastAt:Date.now(),createdAt:Date.now(),history:[]}]})""")
        await page.wait_for_function("document.querySelector('#total').textContent==='1'")
        assert await page.locator('#working').inner_text()=='1'
        assert await page.locator('#children-count').inner_text()=='1'
        assert await page.locator('.task-row').count()==2
        assert '属于 一个主任务' in await page.locator('.task-card.category-children .roster-project').inner_text()
        await page.evaluate("feedSnapshot({...mockSnapshot,tasks:mockSnapshot.tasks.map(t=>t.id==='parent'?{...t,state:'ended'}:t)})")
        await page.wait_for_function("document.querySelector('#total').textContent==='0'")
        assert await page.locator('.task-row').count()==1
        await page.locator('#demo-mode').click()
        await page.emulate_media(reduced_motion='reduce')
        await page.wait_for_function("document.querySelector('#animation').getAttribute('aria-pressed')==='true'")
        await page.emulate_media(reduced_motion='no-preference')
        await page.set_viewport_size({'width':390,'height':844});await page.wait_for_timeout(300)
        await page.screenshot(path=str(output/'task-town-studio-mobile.png'),full_page=True)
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert await page.locator('.task-row').count()==8
        await page.locator('.task-details').last.click();assert await page.locator('#detail-dialog').is_visible()
        await page.keyboard.press('Escape')
        assert not errors, errors
        print(json.dumps({'browser':'Chromium','fixture':'in-memory UI, mocked streaming fetch',
          'desktop':'1440x1100','mobile':'390x844','console_errors':errors,'mobile_no_page_overflow':True,
          'checks':['filters retain positions','search','modal keyboard close','nickname XSS escaping','paused canvas stable',
                    'viewer header not URL','streamed snapshot','20-resident pagination','mobile resident list','cross-room search stability','safe rename cancellation','invalid snapshot rejection',
                    'empty scene stops timer','dynamic reduced motion','cross-room four-worker count','probe excluded from work count',
                    'desktop worklist visible','counter clears search','list locates numbered resident','shared name and project search','stable keyboard focus','worklist evidence expiry','four active cards above fold without interaction','history leaves current scope','children separate from main count','parent label visible','close decreases current count'],
          'real_browser_server_e2e':False,'real_desktop_hooks_tested':False},ensure_ascii=False,indent=2))
        await browser.close()

if __name__=='__main__':asyncio.run(main())
