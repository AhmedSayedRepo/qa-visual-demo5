const { test, expect } = require('../fixtures');
const { openLoginPage, performLogin, openAppHome } = require('../support/auth');

test.describe("Story file-468f47b54564 \u2014 Imported file: batch10-visual-test-cases.csv", () => {

  // These cases test the LOGIN PAGE itself — they opt out of the
  // shared logged-in session (global-setup.js) with a clean state.
  test.describe('logged out (login page)', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test("Login page looks the same as its baseline", async ({ page, heal }) => {
      await openLoginPage(page);
      await test.step("Step 1 · Open https://the-internet.herokuapp.com/login", async () => {
        await page.goto("https://the-internet.herokuapp.com/login");
      });
      await test.step("Step 1 · Verify: page looks the same as the visual baseline \"login\" within 1%", async () => {
        expect(await heal.assertPage("visual", "login"), "expected page looks the same as the visual baseline \"login\" within 1%").toBeTruthy();
      });
      await test.step("Step 1 · Verify: Login Page", async () => {
        expect(await heal.assertVisible("file-468f47b54564.0.2", {"by": "xpath", "value": "//h2[normalize-space()=\"Login Page\"]", "fallbacks": [{"by": "css", "value": "#content > div.example:nth-of-type(1) > h2:nth-of-type(1)"}]}, {"target": "login page heading", "keywords": ["Login Page"], "kind": "text", "verb": ""})).toBeTruthy();
      });
    });
  });

  test("Checkboxes after ticking the first one", async ({ page, heal }) => {
    await openAppHome(page);
    await test.step("Step 1 · Open https://the-internet.herokuapp.com/checkboxes", async () => {
      await page.goto("https://the-internet.herokuapp.com/checkboxes");
    });
    await test.step("Step 1 · Verify: The page shows \"Checkboxes\"", async () => {
      expect(await heal.assertVisible("file-468f47b54564.1.1", {"by": "xpath", "value": "//h3[normalize-space()=\"Checkboxes\"]", "fallbacks": [{"by": "css", "value": "#content > div.example:nth-of-type(1) > h3:nth-of-type(1)"}]}, {"target": "page heading", "keywords": ["Checkboxes"], "kind": "text", "verb": ""})).toBeTruthy();
    });
    await test.step("Step 2 · Click \"checkbox 1\"", async () => {
      await heal.act("file-468f47b54564.1.2", "click", {"by": "cssSelector", "value": "#checkboxes > input:nth-of-type(1)"}, {"target": "checkbox 1", "keywords": ["checkbox 1"], "kind": "checkbox", "verb": "click"}, "");
    });
    await test.step("Step 2 · Verify: page looks the same as the visual baseline \"checkboxes-ticked\" within 1%", async () => {
      expect(await heal.assertPage("visual", "checkboxes-ticked"), "expected page looks the same as the visual baseline \"checkboxes-ticked\" within 1%").toBeTruthy();
    });
    await test.step("Step 2 · Verify: The \"checkbox 1\" checkbox is checked. The page matches the visual baseline \"checkboxes-ticked\"", async () => {
      expect(await heal.assertChecked("file-468f47b54564.1.4", {"by": "cssSelector", "value": "#checkboxes > input:nth-of-type(1)"}, {"target": "checkbox 1 checked and visual baseline", "keywords": ["checkbox 1"], "kind": "checkbox", "verb": ""})).toBeTruthy();
    });
  });

  test("Challenging DOM ignoring the parts that change on every load", async ({ page, heal }) => {
    await openAppHome(page);
    await test.step("Step 1 · Open https://the-internet.herokuapp.com/challenging_dom", async () => {
      await page.goto("https://the-internet.herokuapp.com/challenging_dom");
    });
    await test.step("Step 1 · Verify: page looks the same as the visual baseline \"challenging-dom\" (ignoring #canvas, .large-2 .button) within 1%", async () => {
      expect(await heal.assertPage("visual", "challenging-dom|#canvas, .large-2 .button|1"), "expected page looks the same as the visual baseline \"challenging-dom\" (ignoring #canvas, .large-2 .button) within 1%").toBeTruthy();
    });
    await test.step("Step 1 · Verify: Challenging DOM", async () => {
      expect(await heal.assertVisible("file-468f47b54564.2.2", {"by": "xpath", "value": "//h3[normalize-space()=\"Challenging DOM\"]", "fallbacks": [{"by": "css", "value": "#content > div.example:nth-of-type(1) > h3:nth-of-type(1)"}]}, {"target": "page heading", "keywords": ["Challenging DOM"], "kind": "text", "verb": ""})).toBeTruthy();
    });
  });

  test("Hovers page has no visual changes within a tolerance", async ({ page, heal }) => {
    await openAppHome(page);
    await test.step("Step 1 · Open https://the-internet.herokuapp.com/hovers", async () => {
      await page.goto("https://the-internet.herokuapp.com/hovers");
    });
    await test.step("Step 1 · Verify: page looks the same as the visual baseline within 2%", async () => {
      expect(await heal.assertPage("visual", "||2"), "expected page looks the same as the visual baseline within 2%").toBeTruthy();
    });
    await test.step("Step 1 · Verify: Hovers", async () => {
      expect(await heal.assertVisible("file-468f47b54564.3.2", {"by": "xpath", "value": "//h3[normalize-space()=\"Hovers\"]", "fallbacks": [{"by": "css", "value": "#content > div.example:nth-of-type(1) > h3:nth-of-type(1)"}]}, {"target": "Hovers heading", "keywords": ["Hovers"], "kind": "text", "verb": ""})).toBeTruthy();
    });
  });

  test("Dynamic content changes (fails from the second run on purpose)", async ({ page, heal }) => {
    await openAppHome(page);
    await test.step("Step 1 · Open https://the-internet.herokuapp.com/dynamic_content", async () => {
      await page.goto("https://the-internet.herokuapp.com/dynamic_content");
    });
    await test.step("Step 1 · Verify: page looks the same as the visual baseline \"dynamic\" within 1%", async () => {
      expect(await heal.assertPage("visual", "dynamic"), "expected page looks the same as the visual baseline \"dynamic\" within 1%").toBeTruthy();
    });
    await test.step("Step 1 · Verify: Dynamic Content", async () => {
      expect(await heal.assertVisible("file-468f47b54564.4.2", {"by": "xpath", "value": "//h3[normalize-space()=\"Dynamic Content\"]", "fallbacks": [{"by": "css", "value": "#content > div.example:nth-of-type(1) > h3:nth-of-type(1)"}]}, {"target": "page heading", "keywords": ["Dynamic Content"], "kind": "text", "verb": ""})).toBeTruthy();
    });
  });
});
