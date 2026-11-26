/**
 * MEVPS 前端构建脚本（零依赖，Node >= 20）
 *
 * 产物输出到 assets/ 目录：
 *   - index.html               入口（不带哈希）
 *   - js/app.<content-hash>.js  前端代码（内容哈希文件名，可长期缓存）
 *   - css/style.<content-hash>.css 样式（内容哈希文件名，可长期缓存）
 *   - _headers                 缓存/安全响应头规则
 *   - favicon.svg
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, 'src');
const out = join(root, 'assets');

// 按顺序拼接的 JS 模块（全局命名空间方式，无打包器依赖）
const JS_MODULES = [
  'js/utils.js',
  'js/api.js',
  'js/ui.js',
  'js/charts.js',
  'js/views/dashboard.js',
  'js/views/vps.js',
  'js/views/logs.js',
  'js/views/settings.js',
  'js/app.js',
];

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

// 清理旧产物
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'js'), { recursive: true });
mkdirSync(join(out, 'css'), { recursive: true });

// ---- JS：拼接 + 内容哈希 ----
const jsCode = JS_MODULES.map((f) => `/* ==== ${f} ==== */\n${readFileSync(join(src, f), 'utf8')}`).join('\n;\n');
const jsBuf = Buffer.from(jsCode, 'utf8');
const jsName = `app.${hash8(jsBuf)}.js`;
writeFileSync(join(out, 'js', jsName), jsBuf);

// ---- CSS：拼接 + 内容哈希 ----
const cssCode = readFileSync(join(src, 'css', 'main.css'), 'utf8');
const cssBuf = Buffer.from(cssCode, 'utf8');
const cssName = `style.${hash8(cssBuf)}.css`;
writeFileSync(join(out, 'css', cssName), cssBuf);

// ---- index.html：替换占位符 ----
let html = readFileSync(join(src, 'index.html'), 'utf8');
html = html
  .replace('<!--{{CSS}}-->', `<link rel="stylesheet" href="/css/${cssName}" />`)
  .replace('<!--{{JS}}-->', `<script src="/js/${jsName}" defer></script>`)
  .replace('{{BUILD_TIME}}', new Date().toISOString().replace('T', ' ').slice(0, 19));
writeFileSync(join(out, 'index.html'), html);

// ---- 静态文件 ----
copyFileSync(join(src, '_headers'), join(out, '_headers'));
copyFileSync(join(src, 'favicon.svg'), join(out, 'favicon.svg'));

console.log('✅ 构建完成 → assets/');
console.log(`   index.html`);
console.log(`   js/${jsName}   (${(jsBuf.length / 1024).toFixed(1)} KB)`);
console.log(`   css/${cssName}  (${(cssBuf.length / 1024).toFixed(1)} KB)`);
console.log('   _headers / favicon.svg');
