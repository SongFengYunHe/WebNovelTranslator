/**
 * 项目公开 URL 的唯一事实来源。
 *
 * 应用过去在五个不同文件里硬编码上游仓库地址，这意味着 fork 的自动更新源会悄悄
 * 指向别人的发布页。现在每个发布/更新 URL 都派生自这里。
 *
 * NOTE: `electron-builder.config.js` 是 CommonJS 构建文件，无法导入这个 TypeScript
 * 模块——它改为从 package.json 的 `repository` 字段推导同一个 URL。仓库迁移时请
 * 同步这两处。
 */

/** 规范仓库的 GitHub 所有者。 */
export const REPO_OWNER = 'SongFengYunHe';

/** GitHub 仓库名。 */
export const REPO_NAME = 'WebNovelTranslator';

/** 规范仓库 URL，结尾不带斜杠。 */
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

/** 面向用户的发布页（每个「打开下载页」操作都使用它）。 */
export const RELEASES_URL = `${REPO_URL}/releases`;

/**
 * electron-builder 的 `generic` 发布端点。它提供 electron-updater 读取的
 * `latest.yml` 源，因此结尾的斜杠是必需的。
 */
export const UPDATE_FEED_URL = `${RELEASES_URL}/latest/download/`;