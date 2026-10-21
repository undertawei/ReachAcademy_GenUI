import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

declare global {
  interface Window {
    __reachThree?: typeof THREE;
    __reachThreeAddons?: Readonly<{ OrbitControls: typeof OrbitControls }>;
  }
}

/**
 * 把 three.js 以模块形式提供给交互文档。
 *
 * 导入进来的 MAIC 页面原本写的是 `import * as THREE from 'three'`，但交互文档禁止任何
 * import 与网络访问，所以导入期会把这些语句改写成读取下面两个全局。addons 只暴露
 * INTERACTIVE_THREE_SUPPORTED_ADDONS 白名单里的成员——扩容时两边要一起改，否则改写
 * 出来的代码会拿到 undefined。
 *
 * 属性用 defineProperty 挂成不可写、不可枚举，避免页面脚本互相覆盖，也避免被 for...in
 * 之类的遍历意外带出去。
 */
const define = (name: string, value: unknown): void => {
  if (Object.prototype.hasOwnProperty.call(window, name)) {
    throw new Error(`Interactive three runtime global ${name} is already defined.`);
  }
  Object.defineProperty(window, name, {
    value,
    configurable: false,
    enumerable: false,
    writable: false,
  });
};

define('__reachThree', THREE);
define('__reachThreeAddons', Object.freeze({ OrbitControls }));
