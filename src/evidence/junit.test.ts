import { describe, expect, it } from 'vitest';
import { JUnitError, readJUnit } from './junit.js';

const read = (xml: string) => readJUnit(xml, 'report.xml');
const refusal = (xml: string): string => {
  try {
    read(xml);
  } catch (error) {
    expect(error).toBeInstanceOf(JUnitError);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('reading a JUnit report', () => {
  it('reads each test case, with its name, file and status', () => {
    const cases = read(`<?xml version="1.0" encoding="UTF-8"?>
      <testsuites>
        <testsuite name="a" file="a.test.ts">
          <testcase name="passes" classname="A"/>
          <testcase name="fails"><failure message="boom">the stack</failure></testcase>
          <testcase name="is skipped"><skipped/></testcase>
          <testcase name="errs"><error message="crashed"/></testcase>
        </testsuite>
      </testsuites>`);
    expect(cases.map((c) => [c.name, c.classname, c.file, c.status, c.message])).toEqual([
      ['passes', 'A', 'a.test.ts', 'passed', null],
      ['fails', null, 'a.test.ts', 'failed', 'boom'],
      ['is skipped', null, 'a.test.ts', 'skipped', null],
      ['errs', null, 'a.test.ts', 'failed', 'crashed'],
    ]);
  });

  it('takes a failure\'s message from its text when it has no message attribute', () => {
    expect(read('<testsuite><testcase name="x"><failure>\n\n  first line\nsecond</failure></testcase></testsuite>')[0]!.message).toBe('first line');
  });

  // A test case's own file wins over its suite's, and the nearest suite's over
  // one further out.
  it('takes the file from the test case, or the nearest suite around it', () => {
    const cases = read(`<testsuites>
      <testsuite file="outer.test.ts">
        <testsuite name="inner" file="inner.test.ts"><testcase name="a"/></testsuite>
        <testsuite name="plain"><testcase name="b"/></testsuite>
        <testcase name="c" file="own.test.ts"/>
      </testsuite>
      <testsuite><testcase name="d"/></testsuite>
    </testsuites>`);
    expect(cases.map((c) => [c.name, c.file])).toEqual([['a', 'inner.test.ts'], ['b', 'outer.test.ts'], ['c', 'own.test.ts'], ['d', null]]);
  });

  it('reads properties, from the value attribute or from the text, a name given twice kept twice', () => {
    const [c] = read(`<testsuite><testcase name="x"><properties>
      <property name="line" value="3"/>
      <property name="scenario" value="AC0001.1"/>
      <property name="scenario" value="AC0001.2"/>
      <property name="long">  a long &amp; text  </property>
    </properties></testcase></testsuite>`);
    expect(c!.properties).toEqual({ line: ['3'], scenario: ['AC0001.1', 'AC0001.2'], long: ['a long & text'] });
  });

  it('decodes the five entities and character references, in attributes and in text', () => {
    const [c] = read('<testsuite><testcase name="a &lt; b &gt; c &amp; &quot;d&quot; &apos;e&apos; &#65;&#x42; &#x1F600;"/></testsuite>');
    expect(c!.name).toBe(`a < b > c & "d" 'e' AB 😀`);
  });

  it('decodes a reference written with an uppercase X, and the highest code point there is', () => {
    expect(read('<testsuite><testcase name="&#X41;&#x10FFFF;&#1114111;"/></testsuite>')[0]!.name).toBe('A\u{10FFFF}\u{10FFFF}');
  });

  it('allows whitespace before the end of an end tag', () => {
    expect(read('<testsuites ><testsuite>\n<testcase name="x"></testcase >\n</testsuite\t></testsuites  >')).toHaveLength(1);
  });

  // Properties live in `<properties>`, and nowhere else counts.
  it('reads properties only from <property> elements inside <properties>', () => {
    const [c] = read(`<testsuite><testcase name="x">
      <system-out><property name="elsewhere" value="1"/></system-out>
      <properties><other/><property name="kept" value="2"/></properties>
    </testcase></testsuite>`);
    expect(c!.properties).toEqual({ kept: ['2'] });
  });

  it('trims a failure message, and falls back to its text when the message is empty', () => {
    expect(read('<testsuite><testcase name="x"><failure message="  boom  "/></testcase></testsuite>')[0]!.message).toBe('boom');
    expect(read('<testsuite><testcase name="x"><failure message="">from the text</failure></testcase></testsuite>')[0]!.message).toBe('from the text');
  });

  // Only a test suite names the file of the cases inside it.
  it('takes no file from an element that is not a test suite', () => {
    expect(read('<testsuites file="all.test.ts"><testsuite><testcase name="a"/></testsuite></testsuites>')[0]!.file).toBeNull();
  });

  it('reads CDATA as it stands, and skips comments and the declaration', () => {
    const [c] = read(`﻿<?xml version="1.0"?><!-- written by a tool -->
      <testsuite><!-- one --><testcase name="x"><failure><![CDATA[ <b>raw</b> & more ]]></failure></testcase></testsuite>`);
    expect(c!.message).toBe('<b>raw</b> & more');
  });

  it('reads single-quoted attributes and spaces around the equals sign', () => {
    expect(read("<testsuite><testcase name = 'a \"quoted\" name'/></testsuite>")[0]!.name).toBe('a "quoted" name');
  });

  it('reads a report with no test cases as none', () => {
    expect(read('<testsuites/>')).toEqual([]);
    expect(read('<testsuites><testsuite name="empty"></testsuite></testsuites>')).toEqual([]);
  });
});

/**
 * A report read wrong could read as a pass, so anything the reader does not
 * understand is refused, and the message says where.
 */
describe('a report the reader refuses', () => {
  it('refuses a root that is not a test suite, since it would hold no test cases', () => {
    expect(refusal('<results><testcase name="x"/></results>')).toBe('report.xml: the root element is <results>, so this is not a JUnit report');
  });

  it('refuses tags that do not match or are never closed, naming the line', () => {
    expect(refusal('<testsuites>\n<testsuite></testsuites>\n\n\n')).toBe('report.xml:2: </testsuites> closes <testsuite>');
    expect(refusal('<testsuites><testsuite>')).toMatch(/<testsuite> is never closed/);
    expect(refusal('<testsuites></testsuite></testsuites>')).toMatch(/closes <testsuites>/);
    expect(refusal('<testsuites/></testsuites>')).toMatch(/<\/testsuites> closes nothing/);
  });

  it('refuses an entity XML does not define, and a "&" that starts no reference', () => {
    expect(refusal('<testsuite><testcase name="a&nbsp;b"/></testsuite>')).toMatch(/the entity "&nbsp;" is not one XML defines/);
    expect(refusal('<testsuite><testcase name="a & b"/></testsuite>')).toMatch(/a "&" that starts no reference/);
    expect(refusal('<testsuite><testcase name="&#xZZ;"/></testsuite>')).toMatch(/the reference "&#xZZ;" is malformed/);
    expect(refusal('<testsuite><testcase name="&#12a;"/></testsuite>')).toMatch(/the reference "&#12a;" is malformed/);
  });

  // Junk at only one end, and a code point past the last there is: each read
  // as a number by a lenient parse, so the whole reference has to be checked.
  it('refuses a reference with junk at either end, or past the last code point', () => {
    for (const ref of ['&#x1Z;', '&#xZ1;', '&#a12;', '&#12a;', '&#x110000;', '&#1114112;']) {
      expect(refusal(`<testsuite><testcase name="${ref}"/></testsuite>`), ref).toBe(`report.xml: the reference "${ref}" is malformed`);
    }
  });

  it('refuses text or CDATA outside the root, even one character after it', () => {
    expect(refusal('<testsuites/>x')).toMatch(/text outside the root element/);
    expect(refusal('<![CDATA[x]]><testsuites/>')).toMatch(/CDATA outside the root element/);
  });

  it('refuses a tag or an end tag with no name, and an end tag with more in it', () => {
    expect(refusal('<testsuites></ >')).toMatch(/an end tag with no name/);
    expect(refusal('<testsuites>< x/></testsuites>')).toMatch(/a tag with no name/);
    expect(refusal('<testsuites></testsuites x>')).toMatch(/the end tag <\/testsuites> is malformed/);
  });

  // A document type can define entities of its own, which would change what
  // the text says.
  it('refuses a document type declaration', () => {
    expect(refusal('<!DOCTYPE testsuites [<!ENTITY x "y">]><testsuites/>')).toMatch(/a document type declaration/);
  });

  it('refuses malformed attributes', () => {
    expect(refusal('<testsuite><testcase name=x/></testsuite>')).toMatch(/is not quoted/);
    expect(refusal('<testsuite><testcase name/></testsuite>')).toMatch(/has no value/);
    expect(refusal('<testsuite><testcase name x="a"/></testsuite>')).toMatch(/the attribute "name" of <testcase> has no value/);
    expect(refusal('<testsuite><testcase 1x="a"/></testsuite>')).toMatch(/the tag <testcase> has a malformed attribute/);
    expect(refusal('<testsuite><testcase name="x')).toMatch(/the attribute "name" of <testcase> is never closed/);
    expect(refusal('<testsuite><testcase name="a<b"/></testsuite>')).toMatch(/the attribute "name" of <testcase> holds a "<"/);
    expect(refusal('<testsuite><testcase name="x" name="y"/></testsuite>')).toMatch(/the attribute "name" twice/);
    expect(refusal('<testsuite><testcase name="x/></testsuite>')).toMatch(/holds a "<"|is never closed/);
    expect(refusal('<testsuite><testcase name="x"file="y"/></testsuite>')).toMatch(/is malformed/);
  });

  it('refuses text outside the root, a second root, and no root at all', () => {
    expect(refusal('loose text <testsuites/>')).toMatch(/text outside the root element/);
    expect(refusal('<testsuites/><testsuites/>')).toMatch(/a second root element/);
    expect(refusal('<!-- only a comment -->')).toMatch(/no root element/);
    expect(refusal('')).toMatch(/no root element/);
  });

  it('refuses sections that are never closed', () => {
    expect(refusal('<testsuites><!-- open')).toMatch(/a comment is never closed/);
    expect(refusal('<testsuites><![CDATA[ open')).toMatch(/a CDATA section is never closed/);
    expect(refusal('<?xml version="1.0"')).toMatch(/a declaration is never closed/);
  });

  it('refuses a test case or a property with no name', () => {
    expect(refusal('<testsuite><testcase/></testsuite>')).toMatch(/a <testcase> has no name/);
    expect(refusal('<testsuite><testcase name="x"><properties><property value="1"/></properties></testcase></testsuite>'))
      .toMatch(/a <property> of "x" has no name/);
  });
});
