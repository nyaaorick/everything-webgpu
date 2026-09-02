/**
 * The toolbar button opens the engine page in a tab.
 *
 * Deliberately not a popup: a popup's document is torn down the moment it loses
 * focus, taking a multi-GB resident model with it. A tab (or, in a real
 * extension, a persistent background page as in the main repo) is the context
 * that can actually hold one.
 */
browser.browserAction.onClicked.addListener(() => {
  browser.tabs.create({ url: browser.runtime.getURL("index.html") });
});
