'use strict';
exports.activate = async context => {
  const { startCompanion } = await import('./controller.mjs');
  return startCompanion(require('vscode'), context);
};
