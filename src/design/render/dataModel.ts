import { diffDataModel, parseDataModel, plainDataModel } from "../dataModel.js";
import { erdSvg } from "../erd.js";
import { loadedMeasure } from "./fonts.js";
import { tryParse, type Prepare } from "./types.js";

export const prepare: Prepare = async (source, base) => {
  const model = parseDataModel(source);
  const baseModel = tryParse(parseDataModel, base);
  const plain = plainDataModel(model);
  const diff = baseModel ? diffDataModel(baseModel, model) : plain;
  const measure = await loadedMeasure();
  return {
    counts: diff.counts,
    comparable: baseModel !== null,
    draw(root, compare) {
      root.innerHTML = erdSvg(compare ? diff : plain, { compare, measure });
    },
    exportSvg: () => erdSvg(plain, { compare: false, measure }),
  };
};
