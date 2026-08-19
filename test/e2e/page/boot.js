/** TEMPORARY: opens the self-test page once the engine host is up. */
browser.tabs.create({ url: browser.runtime.getURL("src/devtest/devtest.html") });
