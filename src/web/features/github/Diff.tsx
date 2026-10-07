import { useMemo, useState } from "react";
import {
  groupByDirectory,
  parsePatch,
  type PrFile,
} from "../../../shared/github.js";
import { Stats } from "./parts.js";

/** Files with more changed lines than this start collapsed. */
const LARGE_FILE = 400;
/** Past this many files, every file starts collapsed. */
const MANY_FILES = 40;

const anchor = (filename: string) =>
  `kim-github-file-${filename.replace(/[^\w-]/g, "_")}`;

/** The full diff: a file tree on the left and a unified diff per file. */
export function DiffViewer({ files }: { files: PrFile[] }) {
  const groups = useMemo(() => groupByDirectory(files), [files]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const isOpen = (file: PrFile) =>
    open[file.filename] ??
    (files.length <= MANY_FILES &&
      file.patch !== null &&
      file.additions + file.deletions <= LARGE_FILE);
  const toggle = (file: PrFile, value = !isOpen(file)) =>
    setOpen((current) => ({ ...current, [file.filename]: value }));
  const jump = (file: PrFile) => {
    toggle(file, true);
    requestAnimationFrame(() =>
      document
        .getElementById(anchor(file.filename))
        ?.scrollIntoView({ block: "start" }),
    );
  };
  // The tree's order, so the diffs read in the same order.
  const ordered = groups.flatMap((group) => group.files);
  return (
    <div className="kim-github-diff">
      <nav className="kim-github-tree" aria-label="Changed files">
        {groups.map((group) => (
          <div key={group.dir}>
            {group.dir && <div className="kim-github-dir">{group.dir}/</div>}
            {group.files.map((file) => (
              <button
                type="button"
                key={file.filename}
                className="kim-github-leaf"
                onClick={() => jump(file)}
                title={file.filename}
              >
                <span className="kim-github-leaf-name">
                  {file.filename.slice(group.dir ? group.dir.length + 1 : 0)}
                </span>
                <Stats add={file.additions} del={file.deletions} />
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="kim-github-files">
        {ordered.map((file) => (
          <FileDiff
            key={file.filename}
            file={file}
            open={isOpen(file)}
            toggle={() => toggle(file)}
          />
        ))}
      </div>
    </div>
  );
}

function FileDiff({
  file,
  open,
  toggle,
}: {
  file: PrFile;
  open: boolean;
  toggle: () => void;
}) {
  const hunks = useMemo(
    () => (open && file.patch ? parsePatch(file.patch) : []),
    [open, file.patch],
  );
  return (
    <section className="kim-github-file" id={anchor(file.filename)}>
      <button
        type="button"
        className="kim-github-file-head"
        onClick={toggle}
        aria-expanded={open}
      >
        <span className="kim-github-chevron">{open ? "▾" : "▸"}</span>
        <span className="kim-github-mono kim-github-file-name">
          {file.previousFilename && file.previousFilename !== file.filename
            ? `${file.previousFilename} → ${file.filename}`
            : file.filename}
        </span>
        {file.status !== "modified" && (
          <span className="kim-github-muted">{file.status}</span>
        )}
        <Stats add={file.additions} del={file.deletions} />
      </button>
      {open &&
        (file.patch === null ? (
          <p className="kim-github-muted kim-github-pad">
            No diff to show (binary or too large for GitHub's API).
          </p>
        ) : (
          <table className="kim-github-lines">
            <tbody>
              {hunks.map((hunk, h) => [
                <tr key={`h${h}`} className="kim-github-hunk">
                  <td colSpan={3}>{hunk.header}</td>
                </tr>,
                ...hunk.lines.map((line, i) => (
                  <tr key={`${h}-${i}`} className={`kim-github-${line.kind}`}>
                    <td className="kim-github-no">{line.oldNo ?? ""}</td>
                    <td className="kim-github-no">{line.newNo ?? ""}</td>
                    <td className="kim-github-code">
                      {line.kind === "add"
                        ? "+"
                        : line.kind === "del"
                          ? "-"
                          : line.kind === "ctx"
                            ? " "
                            : ""}
                      {line.text}
                    </td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        ))}
    </section>
  );
}
