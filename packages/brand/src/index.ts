import { brandTokens } from './tokens.js';

export {
  brandCssVariables,
  brandTokens,
  type BrandCssVariables,
  type BrandTokens,
} from './tokens.js';

export const brandAssetPaths = {
  logoMarkRed: './assets/logo-mark-red.svg',
  logoMarkBlack: './assets/logo-mark-black.svg',
  logoMarkWhite: './assets/logo-mark-white.svg',
} as const;

export const brandConfig = {
  id: 'reachany',
  name: 'ReachAny',
  platformName: 'Reach Academy',
  platformNameZh: '无垠学堂',
  supportEmail: 'support@example.invalid',
  assets: brandAssetPaths,
  tokens: brandTokens,
} as const;

export type BrandConfig = typeof brandConfig;
