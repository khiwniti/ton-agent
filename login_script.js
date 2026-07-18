const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    await page.goto('http://localhost:3000/login');
    await page.fill('input[name="password"]', 'Admin1234!');
    await page.click('button[type="submit"]');
    
    // Wait for response or navigation
    await page.waitForURL('**/dashboard', { timeout: 5000 });
    console.log('Successfully navigated to dashboard');
  } catch (e) {
    console.log('Login failed or timed out:', e.message);
  } finally {
    await browser.close();
  }
})();
