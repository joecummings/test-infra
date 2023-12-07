import { basicSetup } from "@codemirror/basic-setup";
import { codeFolding, foldAll, foldService } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  Range,
  RangeSet,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { parse } from "ansicolor";
import {
  search,
  setSearchQuery,
  SearchQuery,
  openSearchPanel,
  SearchCursor,
  findNext,
} from "@codemirror/search";

import { oneDark } from "@codemirror/theme-one-dark";
import { isFailure } from "lib/JobClassifierUtil";
import { JobData, LogAnnotation } from "lib/types";
import { useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr";
import LogAnnotationToggle from "./LogAnnotationToggle";

const ESC_CHAR_REGEX = /\x1b\[[0-9;]*m/g;
// Based on the current editor view, produce a series of decorations that
// correctly colorize the ANSI escape codes found in the view.
function computeDecorations(view: EditorView) {
  let builder: Range<Decoration>[] = [];

  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const lineText = line.text;
      // If we detect an escape code in this line
      if (lineText.includes("\x1b[")) {
        // Build highlight colors for this line.
        const parsed = parse(lineText);

        // Cursor for tracking our position while processing the line.
        let cursor = 0;

        // @ts-expect-error
        // Iterate through each segment of the line that has a color.
        for (const segment of parsed) {
          // Find the start position of this segment within the line, starting
          // at the cursor.
          const startWithinLine = lineText.indexOf(segment.text, cursor);

          // Translate that position to an absolute position within the document.
          const decoFrom = pos + startWithinLine;
          const decoTo = decoFrom + segment.text.length;

          // Add a decoration based on the computed style.
          if (segment.css === "color:rgba(0,0,0,0.5);") {
            // LogViewer has a dark background, so rewrite black to be...not black.
            segment.css = "color:rgba(171,178,191,0.75);";
          }
          builder.push(
            Decoration.mark({ attributes: { style: segment.css } }).range(
              decoFrom,
              decoTo
            )
          );

          // Update our cursor within the line.
          cursor = startWithinLine + segment.text.length;
        }

        // Also hide all the weird escape characters.
        for (const match of lineText.matchAll(ESC_CHAR_REGEX)) {
          const startWithinLine = match.index;
          const decoFrom = pos + startWithinLine!;
          const decoTo = decoFrom + match[0].length;

          builder.push(
            Decoration.replace({ inclusiveStart: true }).range(decoFrom, decoTo)
          );
        }
      }

      // Update our position within the viewport.
      pos = line.to + 1;
    }
  }
  return RangeSet.of(builder, /*sort=*/ true);
}

// Fold the uninteresting parts of the log.
// - Anything in a GitHub group (e.g. gets automatically collapse in GitHub UI)
// - All the "cleanup" stuff (e.g. anything after the actual build/test). This
//   part is hardcoded but should be good enough for starters.
const foldUninteresting = foldService.of(
  (state: EditorState, lineStart: number, lineEnd: number) => {
    const startingLine = state.doc.lineAt(lineStart);
    if (!startingLine.text.includes("##[group]")) {
      return null;
    }

    // If this group begins the teardown process, just fold the entire rest of
    // the document.
    if (
      startingLine.text.includes(".github/actions/teardown") ||
      startingLine.text.includes("Post job cleanup.")
    ) {
      return { from: lineStart, to: state.doc.length };
    }

    // Otherwise find the ##[endgroup] line.
    for (let pos = lineEnd + 1; pos < state.doc.length; ) {
      const line = state.doc.lineAt(pos);
      if (line.text.includes("##[endgroup]")) {
        return { from: lineStart, to: line.to };
      }
      pos = line.to + 1;
    }

    return null;
  }
);

// View plugin for displaying ANSI colors in the log viewer correctly.
// The real logic is in computeDecorations()
const ansiColors = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = computeDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged)
        this.decorations = computeDecorations(update.view);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

const fetcher = (url: string) => fetch(url).then((res) => res.text());

function wrapper({
  url,
  line,
  query,
}: {
  url: string;
  line: number | null;
  query?: string;
}) {
  const { data } = useSWRImmutable(url, fetcher);

}

function Log({
  url,
  line,
  query,
}: {
  url: string;
  line: number | null;
  query?: string;
}) {
  const { data } = useSWRImmutable(url, fetcher);
  const viewer = useRef<HTMLDivElement>(null!);
  const state = EditorState.create({
    doc: data ?? "loading...",
    extensions: [
      basicSetup, // standard text editor things
      EditorState.readOnly.of(true), // make the editor read-only
      EditorView.theme({ "&": { height: "50vh" } }), // set height
      EditorView.theme({ ".cm-activeLine": { backgroundColor: "indigo" } }), // set height
      oneDark, // set theme
      ansiColors, // properly render ansi colors in the logs
      foldUninteresting, // Fold the uninteresting parts of the log to clean up the view.
      codeFolding({
        placeholderText: "<probably uninteresting folded group, click to show>",
      }),
      search({ top: true }),
    ],
  });
  const threshold = 100;
  const [matches, setMatches] = useState<number[]>([]);
  const [show, setShow] = useState<boolean>(false);
  const [currentLine, setCurrentLine] = useState<number>(line ?? 0);

  // const view = new EditorView({ state, parent: viewer.current });
  // foldAll(view);

  useEffect(() => {
    if (data !== undefined && query !== undefined) {
      const searchQuery = new SearchQuery({ search: query });
      let cursor = searchQuery.getCursor(state.doc) as SearchCursor;
      cursor.next();
      const quickMatches = [];
      while (!cursor.done && quickMatches.length < threshold) {
        const line = state.doc.lineAt(
          EditorSelection.single(cursor.value.from, cursor.value.to).main.head
        );
        quickMatches.push(line.number);
        cursor.next();
      }
      setMatches(quickMatches);
    }
  }, [data, query]);

  useEffect(() => {
    if (show) {
      const view = new EditorView({ state, parent: viewer.current });
      foldAll(view);

      if (currentLine > 0) {
        const focusLine = state.doc.line(currentLine);
        view.dispatch({
          selection: EditorSelection.cursor(focusLine.from),
          effects: EditorView.scrollIntoView(focusLine.from, { y: "center" }),
        });
      }

      return () => {
        view.destroy();
      }
    }
  }, [show, currentLine]);

  let lines = Array.from(new Set(matches));
  return (
    <>
      <div>
        {matches.length > 0 ? (
          <div onClick={() => setShow(!show)}>
            {show ? "▼ " : "▶ "}Found{" "}
            {matches.length < threshold ? matches.length : "100+"} matches on{" "}
            {lines.length} lines
          </div>
        ) : (
          <div>No matches</div>
        )}
      </div>
      {show &&
        lines.map((line) => (
          <div
            style={{
              textOverflow: "ellipsis",
              overflow: "hidden",
              whiteSpace: "nowrap",
            }}
            key={`show-line-${url}-${line}`}
            onClick={() => setCurrentLine(line)}
          >
            Go to line: <code>{line}  {state.doc.line(line).text}</code>
          </div>
        ))}
      <div ref={viewer}></div>
    </>
  );
}

export default function LogViewer2({
  job,
  query,
  logRating = LogAnnotation.NULL,
  showAnnotationToggle = process.env.DEBUG_LOG_CLASSIFIER === "true",
  maxNumFailureLines = process.env.DEBUG_LOG_CLASSIFIER === "true" ? 2 : 1,
}: {
  job: JobData;
  query: string;
  logRating?: LogAnnotation;
  showAnnotationToggle?: boolean;
  maxNumFailureLines?: number;
}) {
  // @TODO: PaliC
  // const numFailureLines =
  //   Math.min(job.failureLines?.length || 0, maxNumFailureLines);
  // we will replace this with the code above once we support having multiple failure lines in rockset
  const numFailureLines = maxNumFailureLines;
  const [showLogViewer, setShowLogViewer] = useState<boolean[]>(
    Array.from({ length: numFailureLines }, () => false)
  );

  useEffect(() => {
    document.addEventListener("copy", (e) => {
      const selection = document.getSelection();
      e.clipboardData?.setData(
        "text/plain",
        (selection?.toString() ?? "").replaceAll(ESC_CHAR_REGEX, "")
      );
      e.preventDefault();
    });
  });
  if (!job.failureLines && !isFailure(job.conclusion)) {
    return null;
  }

  const toggleLogViewer = (index: number) => {
    // Make a copy of the current array state
    const updatedShowLogViewer = [...showLogViewer];

    // Toggle the boolean value at the given index
    updatedShowLogViewer[index] = !updatedShowLogViewer[index];

    // Update the state
    setShowLogViewer(updatedShowLogViewer);
  };
  return (
    <div>
      {showLogViewer.map((show, index) => (
        <div key={index}>
          <button
            style={{ background: "none", cursor: "pointer" }}
            onClick={() => toggleLogViewer(index)}
          >
            {show ? "▼ " : "▶ "}
            <code>
              {(job.failureLines && job.failureLines[index]) ?? "Show log"}
            </code>
          </button>
          {(show || query) && (
            <Log url={job.logUrl!} line={job.failureLineNumbers![index]} query={query}/>
          )}
        </div>
      ))}
      {showAnnotationToggle && (
        <div>
          <LogAnnotationToggle
            job={job}
            // send in real metadata later
            log_metadata={{ job_id: "1" }}
            annotation={logRating}
          />
        </div>
      )}
    </div>
  );
}
