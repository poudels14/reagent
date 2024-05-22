import { transformSync, DEFAULT_EXTENSIONS } from "@babel/core";

import createBabelPlugin from "../babel/index.js";

function cleanUrl(url) {
  const queryRE = /\?.*$/s;
  const hashRE = /#.*$/s;
  return url.replace(hashRE, "").replace(queryRE, "");
}

const filterRegex = new RegExp(
  `\\.(${[...DEFAULT_EXTENSIONS, "tsx", "ts"].join("|").replace(/\./g, "")})$`
);

/**
 * @typedef Options
 * @type {object}
 *
 * @property {string[]} tools - absolute paths to the Agent tools.
 * This can either be path to individual paths or paths to the directory
 * where the tools are located. This must be provided for the tools to be
 * compiled properly. Narrowing this path could speed up build.
 * @property {string[]} presets - babel presets
 * @property {string[]} plugins - babel plugins
 */

/**
 *
 * @param {Options} options
 * @returns
 */
const createPlugin = (options = {}) => {
  const toolsPath = options.tools;
  if (!toolsPath) {
    throw new Error(`missing "tools" option`);
  }
  return {
    name: "vite-plugin-portal-cortex",
    transform(code, id, transformOptions) {
      if (!transformOptions) {
        throw new Error(
          `expected valid "options" argument in vite "transform" method`
        );
      }
      const filepath = cleanUrl(id);
      if (
        !filterRegex.test(filepath) ||
        !toolsPath.find((tp) => filepath.startsWith(tp))
      ) {
        return;
      }

      const { code: transformedCode, map } = transformSync(code, {
        configFile: false,
        babelrc: false,
        filename: id,
        sourceFileName: filepath,
        plugins: [
          createBabelPlugin({
            ssr: transformOptions.ssr,
          }),
          ...(options.plugins || []),
        ],
        presets: options.presets || [],
        sourceMaps: true,
      });
      return { code: transformedCode, map };
    },
  };
};

export default createPlugin;
