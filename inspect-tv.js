const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function main() {
  const targetUrl = process.argv[2] || 'https://redflix.co/play?id=95350&type=tv';
  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--no-sandbox', '--start-maximized'],
  });
  const [page] = await browser.pages();
  const network = [];
  page.on('response', (response) => {
    const url = response.url();
    if (/api|season|episode|\/tv\//i.test(url)) network.push({ status: response.status(), url });
  });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  const dom = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    text: document.body.innerText.slice(0, 16000),
    controls: [...document.querySelectorAll('button,select,option,[role="button"]')]
      .map((element, index) => ({
        index,
        tag: element.tagName,
        text: (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' '),
        id: element.id,
        className: typeof element.className === 'string' ? element.className : '',
        value: element.value || '',
      }))
      .filter((item) => /season|episode|S\d+|E\d+/i.test(item.text)),
    links: [...document.querySelectorAll('a[href]')]
      .map((anchor) => anchor.href)
      .filter((url) => /season|episode|type=tv/i.test(url)),
  }));
  console.log(JSON.stringify({
    dom,
    network: [...new Map(network.map((item) => [item.url, item])).values()],
  }, null, 2));
  await browser.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
