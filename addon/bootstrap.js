"use strict";

var { Services } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs");
var moduleUrl;

async function startup(data, reason) {
  moduleUrl = `${data.rootURI}content/zotero-ai-explain.sys.mjs`;
  const module = ChromeUtils.importESModule(moduleUrl);
  await module.startup({ Zotero, reason });
}

async function shutdown(_data, reason) {
  if (typeof APP_SHUTDOWN !== "undefined" && reason === APP_SHUTDOWN) {
    return;
  }

  if (moduleUrl === undefined) {
    return;
  }

  const module = ChromeUtils.importESModule(moduleUrl);
  await module.shutdown({ Zotero, reason });
  Services.obs.notifyObservers(null, "startupcache-invalidate");
}
