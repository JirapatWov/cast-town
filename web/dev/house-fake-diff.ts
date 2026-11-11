// A realistic-looking unified diff for the TV in the house dev harness.
export const FAKE_DIFF = `diff --git a/src/todos.ts b/src/todos.ts
index 3b18e51..a4c09f2 100644
--- a/src/todos.ts
+++ b/src/todos.ts
@@ -1,18 +1,39 @@
 export interface Todo {
   id: number;
   title: string;
+  done: boolean;
   createdAt: number;
 }

 const todos = new Map<number, Todo>();
 let nextId = 1;

-export function addTodo(title: string): Todo {
-  const todo = { id: nextId++, title, createdAt: Date.now() };
+export function addTodo(title: string): Todo {
+  const clean = title.trim();
+  if (!clean) throw new ValidationError('title must not be empty');
+  if (clean.length > 200) throw new ValidationError('title is too long');
+  const todo: Todo = { id: nextId++, title: clean, done: false, createdAt: Date.now() };
   todos.set(todo.id, todo);
   return todo;
 }

+export function markDone(id: number, done = true): Todo {
+  const todo = todos.get(id);
+  if (!todo) throw new NotFoundError(\`todo \${id} not found\`);
+  todo.done = done;
+  return todo;
+}
+
+export class ValidationError extends Error {}
+export class NotFoundError extends Error {}
+
 export function listTodos(): Todo[] {
   return [...todos.values()];
 }
diff --git a/src/server.ts b/src/server.ts
index 91ac2d0..5f1e7b3 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -12,9 +12,20 @@ Bun.serve({
     if (req.method === 'POST' && url.pathname === '/todos') {
       const body = await req.json();
-      return Response.json(addTodo(body.title), { status: 201 });
+      try {
+        return Response.json(addTodo(String(body?.title ?? '')), { status: 201 });
+      } catch (e) {
+        if (e instanceof ValidationError) return Response.json({ error: e.message }, { status: 400 });
+        throw e;
+      }
     }
+    const done = url.pathname.match(/^\\/todos\\/(\\d+)\\/done$/);
+    if (req.method === 'POST' && done) {
+      try { return Response.json(markDone(Number(done[1]))); }
+      catch (e) { if (e instanceof NotFoundError) return Response.json({ error: e.message }, { status: 404 }); throw e; }
+    }
     return new Response('Not found', { status: 404 });
   },
 });
diff --git a/test/todos.test.ts b/test/todos.test.ts
new file mode 100644
--- /dev/null
+++ b/test/todos.test.ts
@@ -0,0 +1,12 @@
+import { expect, test } from 'bun:test';
+import { addTodo, markDone } from '../src/todos';
+
+test('rejects empty titles', () => {
+  expect(() => addTodo('   ')).toThrow('title must not be empty');
+});
+
+test('marks a todo as done', () => {
+  const t = addTodo('buy oat milk');
+  expect(markDone(t.id).done).toBe(true);
+});
`;
