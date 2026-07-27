import { assertEquals } from "jsr:@std/assert@1";
import {
  badAttributes,
  badTextNodes,
  findUnpublishable,
} from "./publish_gate.ts";

Deno.test("badTextNodes catches an exact >undefined< text node", () => {
  const html = `<span class="who">undefined</span>`;
  assertEquals(badTextNodes(html), ["undefined"]);
});

Deno.test("badTextNodes catches every JS stringification", () => {
  const html = "<i>null</i><i>NaN</i><i>Infinity</i><i>-Infinity</i>" +
    "<i>[object Object]</i>";
  assertEquals(badTextNodes(html), [
    "null",
    "NaN",
    "Infinity",
    "-Infinity",
    "[object Object]",
  ]);
});

Deno.test("a title containing the word Null does NOT false-positive", () => {
  // The literal-substring `>frag<` check requires the WHOLE text node to be the
  // fragment; a real title with "Null"/"NaN" inside it is left alone.
  const html = `<div class="title-text">Null Metal Alchemist</div>` +
    `<h3>The NaNny Diaries</h3>`;
  assertEquals(badTextNodes(html), []);
  assertEquals(findUnpublishable(html), []);
});

Deno.test("attribute scan catches a NaN track width the text check misses", () => {
  // >frag< would not fire here: the NaN is between quotes, not > and <.
  const html = `<div class="vrow" style="--p:NaN%"><b></b></div>`;
  assertEquals(badTextNodes(html), []);
  assertEquals(badAttributes(html), [`style="--p:NaN%"`]);
  assertEquals(findUnpublishable(html).length, 1);
});

Deno.test("attribute scan catches an undefined src", () => {
  const html = `<img src="undefined" alt="x">`;
  assertEquals(badAttributes(html), [`src="undefined"`]);
});

Deno.test("a real cover URL and a real style pass clean", () => {
  const html =
    `<img src="https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx1-abc.jpg" alt="«t»">` +
    `<div class="vrow" style="--p:27,3%"></div>`;
  assertEquals(findUnpublishable(html), []);
});
