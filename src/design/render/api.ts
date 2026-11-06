import { diffApi, parseApi, plainApi } from "../api.js";
import { apiHtml, apiSvg } from "../apiView.js";
import { loadedMeasure } from "./fonts.js";
import { tryParse, type Prepare } from "./types.js";

export const prepare: Prepare = async (source, base) => {
  const model = parseApi(source);
  const baseModel = tryParse(parseApi, base);
  const plain = plainApi(model);
  const diff = baseModel ? diffApi(baseModel, model) : plain;
  const measure = await loadedMeasure();
  return {
    counts: diff.counts,
    comparable: baseModel !== null,
    draw(root, compare) {
      root.innerHTML = apiHtml(model, compare ? diff : plain, compare);
    },
    exportSvg: () => apiSvg(model, measure),
  };
};
