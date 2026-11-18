/**
 * Reading a JUnit XML report: the test cases it holds, each with its name,
 * the file it names, what became of it, and its properties.
 *
 * JUnit XML is the one test report almost every runner can write: Vitest,
 * pytest, Go's gotestsum, Maven, Gradle, cargo-nextest. The referee reads it
 * so that a language needs a test command and no translator. It is a file
 * format, not a tool, so reading it here names no tool. See "The test run" in
 * `src/VISION.md`.
 *
 * The XML is read by the small reader below rather than a library. JUnit uses
 * a small part of XML: elements, attributes, text, CDATA, comments and the
 * declaration. A parser library would be a `package.json` change and one more
 * package that every run of the referee trusts. Anything the reader does not
 * understand, such as a document type with entities of its own, is refused
 * rather than skipped, because a report read wrong could read as a pass.
 *
 * There is no single JUnit schema. What the reader holds to is what the
 * common writers agree on:
 *
 * - `<testcase>` elements, at any depth under `<testsuites>` or `<testsuite>`.
 * - A test case failed when it holds `<failure>` or `<error>`, and was skipped
 *   when it holds `<skipped>`. Otherwise it passed.
 * - `file` is an attribute of the test case, or of a test suite around it.
 *   Some writers give none.
 * - `<properties><property name value/></properties>` inside a test case hold
 *   whatever the writer adds. The value is the `value` attribute, or the text
 *   when there is none, as pytest writes long values.
 */

export class JUnitError extends Error {}

interface Element {
  name: string;
  attributes: Record<string, string>;
  children: Element[];
  text: string;
}

export interface JUnitCase {
  /** The test case's `name`, as written. */
  name: string;
  /** Its `classname`, which writers fill with different things: a file, a
   *  class, a module. Never read as a file. */
  classname: string | null;
  /** The `file` attribute of the test case, or of the nearest suite around it
   *  that has one. */
  file: string | null;
  status: 'passed' | 'failed' | 'skipped';
  /** The failure's message, for a failed case. */
  message: string | null;
  /** Every property, by name, in the order written. A name may repeat. */
  properties: Record<string, string[]>;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Text with its references replaced. An entity XML does not predefine is
 *  refused: it could only come from a document type, which is refused too. */
function decode(text: string, where: string): string {
  return text.replace(/&([^;&\s]*);?/g, (whole, ref: string) => {
    if (!whole.endsWith(';')) throw new JUnitError(`${where}: a "&" that starts no reference`);
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const code = Number.parseInt(ref.slice(2), 16);
      if (!/^[0-9a-fA-F]+$/.test(ref.slice(2)) || code > 0x10ffff) throw new JUnitError(`${where}: the reference "${whole}" is malformed`);
      return String.fromCodePoint(code);
    }
    if (ref.startsWith('#')) {
      const code = Number.parseInt(ref.slice(1), 10);
      if (!/^[0-9]+$/.test(ref.slice(1)) || code > 0x10ffff) throw new JUnitError(`${where}: the reference "${whole}" is malformed`);
      return String.fromCodePoint(code);
    }
    const value = ENTITIES[ref];
    if (value === undefined) throw new JUnitError(`${where}: the entity "${whole}" is not one XML defines`);
    return value;
  });
}

const NAME = /^[A-Za-z_:][-A-Za-z0-9_:.]*/;

/**
 * The document's root element, or a `JUnitError` saying what is wrong with
 * it. `where` names the file in every message.
 */
export function parseXml(source: string, where: string): Element {
  let at = 0;
  const fail = (problem: string): never => {
    const line = source.slice(0, at).split('\n').length;
    throw new JUnitError(`${where}:${line}: ${problem}`);
  };
  const stack: Element[] = [];
  let root: Element | null = null;

  const skipUntil = (end: string, what: string) => {
    const close = source.indexOf(end, at);
    if (close === -1) fail(`${what} is never closed`);
    at = close + end.length;
  };

  if (source.charCodeAt(0) === 0xfeff) at = 1;

  while (at < source.length) {
    const open = source.indexOf('<', at);
    const text = source.slice(at, open === -1 ? source.length : open);
    if (text.trim() !== '') {
      if (stack.length === 0) fail('text outside the root element');
      stack[stack.length - 1]!.text += decode(text, where);
    }
    if (open === -1) break;
    at = open;

    if (source.startsWith('<?', at)) {
      skipUntil('?>', 'a declaration');
    } else if (source.startsWith('<!--', at)) {
      skipUntil('-->', 'a comment');
    } else if (source.startsWith('<![CDATA[', at)) {
      if (stack.length === 0) fail('CDATA outside the root element');
      const start = at + '<![CDATA['.length;
      skipUntil(']]>', 'a CDATA section');
      stack[stack.length - 1]!.text += source.slice(start, at - 3);
    } else if (source.startsWith('<!', at)) {
      // A document type can define entities of its own, which would change
      // what the text says. No JUnit writer needs one.
      fail('a document type declaration, which a JUnit report has no need of');
    } else if (source.startsWith('</', at)) {
      at += 2;
      const name = NAME.exec(source.slice(at))?.[0] ?? fail('an end tag with no name');
      at += name.length;
      while (/\s/.test(source[at] ?? '')) at++;
      if (source[at] !== '>') fail(`the end tag </${name}> is malformed`);
      at++;
      const top = stack.pop();
      if (!top) fail(`</${name}> closes nothing`);
      if (top!.name !== name) fail(`</${name}> closes <${top!.name}>`);
    } else {
      at++;
      const name = NAME.exec(source.slice(at))?.[0] ?? fail('a tag with no name');
      at += name.length;
      const element: Element = { name, attributes: {}, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent) {
        parent.children.push(element);
      } else {
        if (root) fail('a second root element');
        root = element;
      }
      for (;;) {
        const space = /^\s*/.exec(source.slice(at))![0].length;
        at += space;
        if (source.startsWith('/>', at)) {
          at += 2;
          break;
        }
        if (source[at] === '>') {
          at++;
          stack.push(element);
          break;
        }
        if (space === 0) fail(`the tag <${name}> is malformed`);
        const attribute = NAME.exec(source.slice(at))?.[0] ?? fail(`the tag <${name}> has a malformed attribute`);
        at += attribute.length;
        const equals = /^\s*=\s*/.exec(source.slice(at))?.[0] ?? fail(`the attribute "${attribute}" of <${name}> has no value`);
        at += equals.length;
        const quote = source[at];
        if (quote !== '"' && quote !== "'") fail(`the attribute "${attribute}" of <${name}> is not quoted`);
        const end = source.indexOf(quote!, at + 1);
        if (end === -1) fail(`the attribute "${attribute}" of <${name}> is never closed`);
        const raw = source.slice(at + 1, end);
        if (raw.includes('<')) fail(`the attribute "${attribute}" of <${name}> holds a "<"`);
        if (attribute in element.attributes) fail(`<${name}> has the attribute "${attribute}" twice`);
        element.attributes[attribute] = decode(raw, where);
        at = end + 1;
      }
    }
  }

  if (stack.length > 0) fail(`<${stack[stack.length - 1]!.name}> is never closed`);
  if (!root) fail('no root element');
  return root!;
}

const firstLine = (text: string): string | null => text.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? null;

/**
 * Every test case in a JUnit report, in the order written.
 *
 * The root must be `<testsuites>` or `<testsuite>`. Anything else is not a
 * JUnit report, and is refused: read as one, it would hold no test cases, and
 * a report with none passes.
 */
export function readJUnit(source: string, where: string): JUnitCase[] {
  const root = parseXml(source, where);
  if (root.name !== 'testsuites' && root.name !== 'testsuite') {
    throw new JUnitError(`${where}: the root element is <${root.name}>, so this is not a JUnit report`);
  }
  const cases: JUnitCase[] = [];

  const visit = (element: Element, file: string | null) => {
    if (element.name === 'testcase') {
      if (element.attributes.name === undefined) throw new JUnitError(`${where}: a <testcase> has no name`);
      const properties: Record<string, string[]> = {};
      for (const group of element.children.filter((c) => c.name === 'properties')) {
        for (const property of group.children.filter((c) => c.name === 'property')) {
          const name = property.attributes.name;
          if (name === undefined) throw new JUnitError(`${where}: a <property> of "${element.attributes.name}" has no name`);
          (properties[name] ??= []).push(property.attributes.value ?? property.text.trim());
        }
      }
      const failure = element.children.find((c) => c.name === 'failure' || c.name === 'error');
      const skipped = element.children.some((c) => c.name === 'skipped');
      cases.push({
        name: element.attributes.name,
        classname: element.attributes.classname ?? null,
        file: element.attributes.file ?? file,
        status: failure ? 'failed' : skipped ? 'skipped' : 'passed',
        message: failure ? (failure.attributes.message?.trim() || firstLine(failure.text)) : null,
        properties,
      });
      return;
    }
    const here = element.name === 'testsuite' ? element.attributes.file ?? file : file;
    for (const child of element.children) visit(child, here);
  };

  visit(root, null);
  return cases;
}
