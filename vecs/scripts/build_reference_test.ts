import { assertEquals } from "jsr:@std/assert@1";
import {
  boxedTitle,
  bulletsUnderHeading,
  decodeEntities,
  pageBody,
  parseCourses,
  parseDimensionPage,
  slugify,
  stripTags,
  transliterate,
  unwrapBullets,
} from "./build_reference.ts";

const VISION = {
  key: "vision",
  letter: "V",
  page: "vision.html",
  title: "Vision",
};

// Trimmed-down copies of the real markup shapes served by the site.
const DIMENSION_HTML =
  `<body><pre class="art-m">art</pre><div class="prose">Что человек видит

Это зона восприятия.

Что сюда входит:

1. Визуальная грамотность

Знания:

- композиция
- ритм

Умения:

- анализировать референсы по устройству, а не по принципу "нравится"
- видеть, почему изображение работает

2. Motion

Знания:

- темп

Умения:

- делать loop-анимации</div><script>x</script></body>`;

const SKILL_PAGE_HTML = `<body><pre>
╔════════╗
║ Motion ║
╚════════╝


Знания:

- ритм
- micro-motion

Умения:

- делать ролики, которые работают как
  демонстрация формы и смысла
</pre><script>x</script></body>`;

const INDEX_HTML = `<body><h1>method</h1>
├── <a href="content.html">КОНТЕНТ</a>
│   ├── <a href="Kurs.html">Курс (<s>$600</s>)</a>
│   └── <a href="Free.html">Бесплатный ($0)</a>
<script>x</script></body>`;

Deno.test("decodeEntities decodes named and numeric escapes", () => {
  assertEquals(
    decodeEntities("&quot;a&quot; &amp; &#x27;b&#x27;"),
    `"a" & 'b'`,
  );
  assertEquals(decodeEntities("&mdash;&nbsp;&#1040;"), "— А");
});

Deno.test("stripTags removes markup but keeps newlines", () => {
  assertEquals(stripTags("<p>a</p>\n<b>b&amp;c</b>"), "a\nb&c");
});

Deno.test("transliterate maps Cyrillic to ASCII", () => {
  assertEquals(transliterate("Щёлк"), "schelk");
  assertEquals(transliterate("Объезд"), "obezd");
});

Deno.test("slugify prefers the canonical map, falls back to translit", () => {
  assertEquals(slugify("Визуальная грамотность"), "visual-literacy");
  assertEquals(slugify("Доведение"), "finishing");
  assertEquals(slugify("Новый Навык"), "novyy-navyk");
  assertEquals(slugify("   "), "untitled");
});

Deno.test("unwrapBullets rejoins hard-wrapped continuation lines", () => {
  const got = unwrapBullets(
    `- анализировать референсы, а не\n  по принципу "нравится"\n- видеть, почему\n  это работает`,
  );
  assertEquals(got, [
    'анализировать референсы, а не по принципу "нравится"',
    "видеть, почему это работает",
  ]);
});

Deno.test("unwrapBullets ignores non-bullet prose", () => {
  assertEquals(unwrapBullets("просто текст\n\nещё текст"), []);
});

Deno.test("boxedTitle reads the ASCII box caption", () => {
  assertEquals(boxedTitle("╔══╗\n║ Motion ║\n╚══╝"), "Motion");
  assertEquals(boxedTitle("no box here"), null);
});

Deno.test("bulletsUnderHeading stops at the next label", () => {
  const section = `Знания:\n\n- a\n- b\n\nУмения:\n\n- c\n`;
  assertEquals(bulletsUnderHeading(section, "Знания"), ["a", "b"]);
  assertEquals(bulletsUnderHeading(section, "Умения"), ["c"]);
  assertEquals(bulletsUnderHeading(section, "Отсутствует"), []);
});

Deno.test("parseDimensionPage splits intro from numbered skills", () => {
  const { intro, skills } = parseDimensionPage(DIMENSION_HTML, VISION);
  assertEquals(intro.startsWith("Что человек видит"), true);
  assertEquals(intro.includes("Что сюда входит"), false);
  assertEquals(skills.length, 2);

  assertEquals(skills[0].slug, "visual-literacy");
  assertEquals(skills[0].position, 1);
  assertEquals(skills[0].dimension, "vision");
  assertEquals(skills[0].dimensionLetter, "V");
  assertEquals(skills[0].knowledge, ["композиция", "ритм"]);
  assertEquals(skills[0].abilities.length, 2);

  assertEquals(skills[1].slug, "motion");
  assertEquals(skills[1].position, 2);
  assertEquals(skills[1].href, "Motion.html");
});

Deno.test("parseDimensionPage returns nothing for a page with no prose", () => {
  assertEquals(parseDimensionPage("<body><pre>x</pre></body>", VISION), {
    intro: "",
    skills: [],
  });
});

Deno.test("parseCourses captures price and strikethrough state", () => {
  const courses = parseCourses(INDEX_HTML);
  assertEquals(courses.length, 2);
  assertEquals(courses[0].title, "Курс");
  assertEquals(courses[0].price, "$600");
  assertEquals(courses[0].priceStruck, true);
  assertEquals(courses[1].priceStruck, false);
});

Deno.test("pageBody strips the ASCII box and returns the prose", () => {
  const body = pageBody(SKILL_PAGE_HTML);
  assertEquals(body.includes("╔"), false);
  assertEquals(bulletsUnderHeading(body, "Знания"), ["ритм", "micro-motion"]);
  assertEquals(bulletsUnderHeading(body, "Умения"), [
    "делать ролики, которые работают как демонстрация формы и смысла",
  ]);
});

Deno.test("pageBody prefers the prose div when both shapes are present", () => {
  assertEquals(
    pageBody(`<body><div class="prose">Диагностика</div></body>`),
    "Диагностика",
  );
  assertEquals(pageBody("<body></body>"), "");
});
