/* Captured from `jj interdiff --git` / `jj diff --git` in colocated repos. */
export const realEdit = String.raw`
diff --git a/f.txt b/f.txt
index 74ef373141..696d2b5086 100644
--- a/f.txt
+++ b/f.txt
@@ -3,5 +3,5 @@
 line 3 UPSTREAM
 line 4
 line 5
-line 6 EDITED BY ME
+line 6 EDITED BY ME, v2
 line 7
`;
export const pureRebase = String.raw``;
export const typescriptPatchset = String.raw`
diff --git a/sum.ts b/sum.ts
index a805a1b610..e310b3c9ee 100644
--- a/sum.ts
+++ b/sum.ts
@@ -1,7 +1,7 @@
 export interface Point { x: number; y: number }
 
 export function distance(a: Point, b: Point): number {
-  const dx = a.x - b.x;
-  const dy = a.y - b.y;
-  return Math.sqrt(dx * dx + dy * dy);
+  return Math.hypot(b.x - a.x, b.y - a.y);
 }
+
+export const origin: Point = { x: 0, y: 0 };
`;
export const typescriptInterdiff = String.raw`
diff --git a/sum.ts b/sum.ts
index cf90116bd6..e310b3c9ee 100644
--- a/sum.ts
+++ b/sum.ts
@@ -1,7 +1,7 @@
 export interface Point { x: number; y: number }
 
 export function distance(a: Point, b: Point): number {
-  return Math.hypot(a.x - b.x, a.y - b.y);
+  return Math.hypot(b.x - a.x, b.y - a.y);
 }
 
 export const origin: Point = { x: 0, y: 0 };
`;
