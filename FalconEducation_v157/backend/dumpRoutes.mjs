import app from './app.js';

function dump(stack, prefix = '') {
  if (!stack) return;
  stack.forEach((layer, index) => {
    const route = layer.route;
    const handle = layer.handle;
    const path = route ? route.path : layer.regexp ? layer.regexp.toString() : '<no-path>';
    const methods = route ? Object.keys(route.methods).join(',') : '';
    console.log(`${prefix}layer ${index}: name=${layer.name} path=${path} methods=${methods}`);
    if (handle && handle.stack) {
      dump(handle.stack, prefix + '  ');
    }
  });
}

console.log('app.router', !!app.router);
if (app.router && app.router.stack) {
  dump(app.router.stack);
}
else {
  console.log('no app.router stack');
}
