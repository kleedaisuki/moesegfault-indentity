import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {chromium} from 'playwright';

/** Exercise actual Login rendering, cookies, CORS, password authentication and consent. */
export async function runDeviceBrowserJourney({root, state, issuer, loginOrigin, password, start, poll}) {
  let logs = '';
  const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--host=localhost', `--port=${new URL(loginOrigin).port}`], {
    cwd: join(root, 'apps/login'), stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, VITE_IDENTITY_API_ORIGIN: issuer},
  });
  for (const stream of [vite.stdout, vite.stderr]) stream.on('data', chunk => { logs = (logs + chunk.toString()).slice(-12000); });
  let browser;
  let page;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (vite.exitCode !== null) throw new Error(`Login development server exited: ${logs}`);
      try {
        if ((await fetch(loginOrigin)).ok) { ready = true; break; }
      } catch { /* Wait for the local Login server to listen. */ }
      await new Promise(done => setTimeout(done, 200));
    }
    assert.ok(ready, `Login development server did not start: ${logs}`);
    browser = await chromium.launch();
    const context = await browser.newContext({viewport: {width: 390, height: 844}, locale: 'en-US'});
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const device = await start();
    await page.goto(device.verification_uri_complete);
    await page.locator('main a[href^="/login?device_user_code="]').click();
    await page.locator('input[name="login"]').fill('devicejourney');
    await page.locator('input[name="password"]').fill(password);
    await page.locator('form').filter({has: page.locator('input[name="password"]')}).locator('button[type="submit"]').click();
    const approve = page.getByRole('button', {name: 'Confirm and allow sign-in', exact: true});
    await approve.waitFor();
    assert.equal(new URL(page.url()).pathname, '/device', 'Password login must return to review');
    const text = await page.locator('main').innerText();
    assert.ok(text.includes('Device Journey') && text.includes(device.user_code) && text.includes('openid profile offline_access'), text);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile consent must not overflow');
    await page.screenshot({path: join(state, 'device-consent-mobile.png'), fullPage: true});
    await page.waitForTimeout(5100);
    const pending = await poll(device);
    assert.equal(pending.status, 400);
    assert.equal((await pending.json()).error, 'authorization_pending', 'Opening the link and signing in must not authorize');
    await approve.click();
    await page.getByRole('heading', {name: 'Device sign-in approved', exact: true}).waitFor();
    await page.waitForTimeout(5100);
    const response = await poll(device);
    assert.equal(response.status, 200, await response.clone().text());
    const tokens = await response.json();
    const denied = await start();
    await page.goto(denied.verification_uri_complete);
    await page.getByRole('button', {name: 'Deny sign-in', exact: true}).click();
    await page.getByRole('heading', {name: 'Sign-in denied', exact: true}).waitFor();
    assert.equal((await (await poll(denied)).json()).error, 'access_denied');
    assert.deepEqual(errors, [], 'Browser must not raise uncaught JavaScript errors');
    console.log(`PASS: mobile browser code link → password login → explicit approval → tokens; deny path. Screenshot: ${join(state, 'device-consent-mobile.png')}`);
    return tokens;
  } catch (error) {
    if (page) {
      await page.screenshot({path: join(state, 'device-browser-failure.png'), fullPage: true});
      console.error(`Browser failure at ${new URL(page.url()).pathname}: ${await page.locator('main').innerText()}`);
    }
    console.error(`Login development server diagnostics:\n${logs}`);
    throw error;
  } finally {
    await browser?.close();
    vite.kill();
  }
}
