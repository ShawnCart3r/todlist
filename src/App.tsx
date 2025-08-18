import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/* ===========================
 * Types
 * =========================== */
type ID = string;
type Priority = "low" | "med" | "high";

interface Task {
  id: ID;
  text: string;
  completed: boolean;
  priority: Priority;
  due?: string;           // ISO date
  tags: string[];
  createdAt: number;
}

interface List {
  id: ID;
  name: string;
  tasks: Task[];
  autoResetMidnight: boolean;
  archived?: boolean;
}

type ListsState = List[];
type IngestMode = "single" | "group";
type IngestTarget = "auto" | "inbox" | "today" | "active";

/* ===========================
 * Utilities & storage (DOM-safe)
 * =========================== */
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const loadLists = (): ListsState => {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem("todo.multilists.v2");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};
const saveLists = (lists: ListsState) => {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("todo.multilists.v2", JSON.stringify(lists));
  } catch {}
};

const loadLastResetDate = () =>
  (typeof window !== "undefined" ? window.localStorage.getItem("todo.lastResetDate.v1") : "") || "";
const saveLastResetDate = (d: string) => {
  if (typeof window !== "undefined") window.localStorage.setItem("todo.lastResetDate.v1", d);
};

const isToday = (iso: string) => {
  if (!iso) return false;
  const a = new Date(iso);
  const b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
};

const norm = (s: string) => s.toLowerCase().trim();

/* ===========================
 * Sortable Task
 * =========================== */
function SortableTask({
  task,
  isDeleting,
  onToggle,
  onDelete,
  onEdit,
}: {
  task: Task;
  isDeleting: boolean;
  onToggle: (id: ID) => void;
  onDelete: (id: ID) => void;
  onEdit: (id: ID, patch: Partial<Task>) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: task.id });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState(task.text);
  const [draftTags, setDraftTags] = useState(task.tags.join(", "));

  useEffect(() => {
    if (!editing) {
      setDraftText(task.text);
      setDraftTags(task.tags.join(", "));
    }
  }, [editing, task.text, task.tags]);

  const commitEdit = () => {
    const tags = draftTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    onEdit(task.id, { text: draftText.trim() || task.text, tags });
    setEditing(false);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`task ${isDeleting ? "deleting" : "appear"}`}
      onDoubleClick={() => setEditing(true)}
    >
      <div className="taskLeft">
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => onToggle(task.id)}
          title="Toggle complete"
        />
        {!editing ? (
          <div className="taskMain">
            <span className={`taskText ${task.completed ? "done" : ""}`}>{task.text}</span>
            {task.tags.length > 0 && (
              <div className="tagRow">
                {task.tags.map((tg) => (
                  <span className="tag" key={tg}>
                    #{tg}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="editBlock">
            <input
              className="editText"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditing(false);
              }}
              autoFocus
              placeholder="Edit task…"
            />
            <input
              className="editTags"
              value={draftTags}
              onChange={(e) => setDraftTags(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEditing(false);
              }}
              placeholder="tags (comma separated)"
            />
          </div>
        )}
      </div>

      <div className="taskRight">
        <button className="dragHandle" title="Drag to reorder" {...attributes} {...listeners}>
          ⋮⋮
        </button>

        {!editing && (
          <button className="icon" title="Edit" onClick={() => setEditing(true)}>
            ✏️
          </button>
        )}

        <select
          value={task.priority}
          onChange={(e) => onEdit(task.id, { priority: e.target.value as Priority })}
          title="Priority"
          className={`prio ${task.priority}`}
        >
          <option value="low">Low</option>
          <option value="med">Med</option>
          <option value="high">High</option>
        </select>

        <input
          type="date"
          value={task.due || ""}
          onChange={(e) => onEdit(task.id, { due: e.target.value || undefined })}
          className="due"
          title="Due date"
        />

        {editing ? (
          <button className="icon confirm" onClick={commitEdit} title="Save">
            ✔️
          </button>
        ) : (
          <button className="icon danger" onClick={() => onDelete(task.id)} title="Delete">
            ❌
          </button>
        )}
      </div>
    </div>
  );
}

/* ===========================
 * Main App
 * =========================== */
export default function App() {
  const [lists, setLists] = useState<ListsState>(() => {
    const initial = loadLists();
    if (initial.length > 0) return initial;
    return [
      { id: uid(), name: "Inbox", tasks: [], autoResetMidnight: false },
      { id: uid(), name: "Today", tasks: [], autoResetMidnight: true },
    ];
  });

  const [activeListId, setActiveListId] = useState<ID>(() => lists[0]?.id || "");
  const [newTask, setNewTask] = useState("");
  const [newListName, setNewListName] = useState("");
  const [search, setSearch] = useState(""); // global search
  const inputRef = useRef<HTMLInputElement>(null);

  // Deleting animation queue
  const [deleting, setDeleting] = useState<Set<ID>>(new Set());

  // THEME
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (typeof window !== "undefined" ? (window.localStorage.getItem("todo.theme") as "dark" | "light") : "dark") || "dark"
  );
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem("todo.theme", theme);
  }, [theme]);

  // persist lists
  useEffect(() => saveLists(lists), [lists]);

  // ensure activeListId exists
  useEffect(() => {
    if (!lists.find((l) => l.id === activeListId) && lists[0]) setActiveListId(lists[0].id);
  }, [lists, activeListId]);

  // Optional midnight auto-clear (DOM-typed timer)
  useEffect(() => {
    const resetIfNeeded = () => {
      const last = loadLastResetDate();
      const todayIso = new Date().toISOString();
      if (!isToday(last)) {
        setLists((prev) => prev.map((l) => (l.autoResetMidnight ? { ...l, tasks: [] } : l)));
        saveLastResetDate(todayIso);
      }
    };
    resetIfNeeded();
    const t = typeof window !== "undefined" ? window.setInterval(resetIfNeeded, 60 * 1000) : 0;
    return () => {
      if (typeof window !== "undefined") window.clearInterval(t);
    };
  }, []);

  // DnD sensors: mouse quick-drag; touch delay to avoid scrolling conflict
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } })
  );

  const listIds: UniqueIdentifier[] = useMemo(() => lists.map((l) => l.id), [lists]);
  const activeList = useMemo(() => lists.find((l) => l.id === activeListId) || lists[0], [lists, activeListId]);

  const addList = () => {
    const name = newListName.trim() || "Untitled";
    const id = uid();
    setLists((ls) => [...ls, { id, name, tasks: [], autoResetMidnight: false }]);
    setNewListName("");
    setActiveListId(id);
  };
  const renameList = (id: ID, name: string) =>
    setLists((ls) => ls.map((l) => (l.id === id ? { ...l, name } : l)));
  const removeList = (id: ID) => {
    setLists((ls) => ls.filter((l) => l.id !== id));
    if (activeListId === id && lists[0]) setActiveListId(lists[0].id);
  };
  const toggleListReset = (id: ID) =>
    setLists((ls) => ls.map((l) => (l.id === id ? { ...l, autoResetMidnight: !l.autoResetMidnight } : l)));

  const addTask = () => {
    const text = newTask.trim();
    if (!text || !activeList) return;
    const t: Task = { id: uid(), text, completed: false, priority: "med", tags: [], createdAt: Date.now() };
    setLists((ls) => ls.map((l) => (l.id === activeList.id ? { ...l, tasks: [t, ...l.tasks] } : l)));
    setNewTask("");
    inputRef.current?.focus();
  };

  const toggleTask = (listId: ID, taskId: ID) => {
    setLists((ls) =>
      ls.map((l) =>
        l.id === listId
          ? { ...l, tasks: l.tasks.map((t) => (t.id === taskId ? { ...t, completed: !t.completed } : t)) }
          : l
      )
    );
  };

  const editTask = (listId: ID, taskId: ID, patch: Partial<Task>) => {
    setLists((ls) =>
      ls.map((l) =>
        l.id === listId ? { ...l, tasks: l.tasks.map((t) => (t.id === taskId ? { ...t, ...patch } : t)) } : l
      )
    );
  };

  const deleteTask = (listId: ID, taskId: ID) => {
    setDeleting((prev) => new Set(prev).add(taskId));
    window.setTimeout(() => {
      setLists((ls) =>
        ls.map((l) => (l.id === listId ? { ...l, tasks: l.tasks.filter((t) => t.id !== taskId) } : l))
      );
      setDeleting((prev) => {
        const n = new Set(prev);
        n.delete(taskId);
        return n;
      });
    }, 180);
  };

  const archiveCompleted = (listId: ID) => {
    setLists((ls) => ls.map((l) => (l.id === listId ? { ...l, tasks: l.tasks.filter((t) => !t.completed) } : l)));
  };

  // helpers
  const findListByName = (name: string) =>
    lists.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase()) || null;
  const getOrCreateListByName = (name: string) => {
    const hit = findListByName(name);
    if (hit) return hit.id;
    const id = uid();
    setLists((ls) => [...ls, { id, name, tasks: [], autoResetMidnight: false }]);
    return id;
  };
  const ensureInboxId = () => getOrCreateListByName("Inbox");

  // QoL helper: find an existing Today without creating it
  const findTodayId = () => findListByName("Today")?.id || null;

  function parseTextToTasks(raw: string, mode: IngestMode, target: IngestTarget): Record<ID, Task[]> {
    const lines = raw
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);

    const makeTask = (text: string): Task => ({
      id: uid(),
      text,
      completed: false,
      priority: "med",
      tags: [],
      createdAt: Date.now(),
    });

    // QoL: if target is "today", only use an existing Today; otherwise use active list (or Inbox)
    const forcedListId =
      target === "inbox" ? ensureInboxId()
      : target === "today"
        ? (findTodayId() ?? (activeList?.id ?? ensureInboxId()))
      : target === "active"
        ? (activeList?.id ?? ensureInboxId())
      : null;

    if (forcedListId) {
      return { [forcedListId]: lines.map(makeTask) };
    }

    if (mode === "single") {
      const lid = activeList?.id ?? ensureInboxId();
      return { [lid]: lines.map(makeTask) };
    }

    // GROUP mode (auto headings create/append lists)
    const result: Record<ID, Task[]> = {};
    let currentListId: ID | null = null;

    const setBucket = (listId: ID) => {
      if (!result[listId]) result[listId] = [];
      currentListId = listId;
    };

    for (const line of lines) {
      const isHeading = /[:：]\s*$/.test(line);
      const bulletMatch = line.match(/^(?:[-*•]\s+|\d+\.\s+)(.+)$/);

      if (isHeading) {
        const name = line.replace(/[:：]\s*$/, "").trim() || "Untitled";
        const lid = getOrCreateListByName(name);
        setBucket(lid);
        continue;
      }

      const text = bulletMatch ? bulletMatch[1].trim() : line;

      if (!currentListId) {
        setBucket(activeList?.id ?? ensureInboxId());
      }

      result[currentListId!].push(makeTask(text));
    }

    return result;
  }

  function addParsedTasks(map: Record<ID, Task[]>) {
    if (!map) return;
    setLists((ls) =>
      ls.map((l) => {
        const incoming = map[l.id];
        if (!incoming || incoming.length === 0) return l;
        return { ...l, tasks: [...incoming, ...l.tasks] };
      })
    );
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const map = parseTextToTasks(text, ingestMode, ingestTarget);
    addParsedTasks(map);

    // QoL: don't auto-create/switch to Today; only switch if Today already exists
    if (ingestTarget === "today") {
      const tid = findTodayId();
      if (tid) setActiveListId(tid);
    } else if (ingestTarget === "inbox") {
      setActiveListId(ensureInboxId());
    }
  }

  function handleDragOverPage(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer?.types?.includes("text/plain")) e.preventDefault();
  }
  function handleDropPage(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    const text = e.dataTransfer.getData("text/plain");
    if (!text) return;
    const map = parseTextToTasks(text, ingestMode, ingestTarget);
    addParsedTasks(map);

    if (ingestTarget === "today") {
      const tid = findTodayId();
      if (tid) setActiveListId(tid);
    } else if (ingestTarget === "inbox") {
      setActiveListId(ensureInboxId());
    }
  }

  // DnD: helpers to locate items
  const findListIdByTask = (taskId: ID): ID | null => {
    for (const l of lists) if (l.tasks.some((t) => t.id === taskId)) return l.id;
    return null;
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as ID;
    const overId = over.id as ID;

    const fromListId = findListIdByTask(activeId);
    const toListId = listIds.includes(overId) ? (overId as ID) : findListIdByTask(overId);
    if (!fromListId || !toListId || fromListId === toListId) return;

    setLists((ls) => {
      const from = ls.find((l) => l.id === fromListId)!;
      const to = ls.find((l) => l.id === toListId)!;

      const activeTask = from.tasks.find((t) => t.id === activeId)!;
      const fromTasks = from.tasks.filter((t) => t.id !== activeId);

      const overIndex = listIds.includes(overId) ? to.tasks.length : to.tasks.findIndex((t) => t.id === overId);
      const toTasks = [...to.tasks];
      const insertIndex = overIndex < 0 ? toTasks.length : overIndex;
      toTasks.splice(insertIndex, 0, activeTask);

      return ls.map((l) => {
        if (l.id === fromListId) return { ...l, tasks: fromTasks };
        if (l.id === toListId) return { ...l, tasks: toTasks };
        return l;
      });
    });
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;
    const activeId = active.id as ID;
    const overId = over.id as ID;

    const fromListId = findListIdByTask(activeId);
    const toListId = listIds.includes(overId) ? (overId as ID) : findListIdByTask(overId);
    if (!fromListId || !toListId) return;

    if (fromListId === toListId) {
      const list = lists.find((l) => l.id === fromListId)!;
      const oldIndex = list.tasks.findIndex((t) => t.id === activeId);
      const newIndex = listIds.includes(overId)
        ? Math.max(0, list.tasks.length - 1)
        : list.tasks.findIndex((t) => t.id === overId);

      if (oldIndex !== newIndex && newIndex >= 0) {
        setLists((ls) =>
          ls.map((l) => (l.id === list.id ? { ...l, tasks: arrayMove(l.tasks, oldIndex, newIndex) } : l))
        );
      }
    }
  };

  /* ---------------------------
   * Ingest (paste/drag) controls
   * --------------------------- */
  const [ingestMode, setIngestMode] = useState<IngestMode>("single");
  const [ingestTarget, setIngestTarget] = useState<IngestTarget>("today");

  const queryTokens = useMemo(
    () => search.split(/\s+/).map(norm).filter(Boolean),
    [search]
  );
  const taskMatches = (t: Task) => {
    if (queryTokens.length === 0) return true;
    const text = norm(t.text);
    const tags = t.tags.map(norm);
    return queryTokens.every((q) => {
      const qTag = q.startsWith("#") ? q.slice(1) : q;
      return text.includes(q) || tags.includes(qTag);
    });
  };

  const filteredLists = useMemo(() => {
    if (queryTokens.length === 0) return lists;
    return lists.map((l) => ({ ...l, tasks: l.tasks.filter(taskMatches) }));
  }, [lists, queryTokens]);

  const dndDisabled = queryTokens.length > 0; // disable reordering while filtered

  /* ---------------------------
   * Render
   * --------------------------- */
  return (
    <div className={`wrap ${theme}`}>
      <header className="header">
        <div className="brand">🗂️ Multi-List To-Do</div>

        <div className="actions">
          <input
            className="searchBox"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search (text or #tag)…"
            title="Search tasks across lists"
          />

          <div className="ingestControls">
            <label className="ingestLabel">
              <span>Mode</span>
              <select
                value={ingestMode}
                onChange={(e) => setIngestMode(e.target.value as IngestMode)}
                className="prio"
                title="How to interpret pasted/dropped text"
              >
                <option value="single">Single (each line = task)</option>
                <option value="group">Group (headings = lists)</option>
              </select>
            </label>

            <label className="ingestLabel">
              <span>Target</span>
              <select
                value={ingestTarget}
                onChange={(e) => setIngestTarget(e.target.value as IngestTarget)}
                className="prio"
                title="Where tasks go"
              >
                <option value="today">Today</option>
                <option value="inbox">Inbox</option>
                <option value="active">Active list</option>
                <option value="auto">Auto (group into lists)</option>
              </select>
            </label>
          </div>

          <button
            className="toggleTheme"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title="Toggle theme"
          >
            {theme === "dark" ? "🌞 Light" : "🌙 Dark"}
          </button>

          <div className="newList">
            <input
              value={newListName}
              onChange={(e) => setNewListName(e.target.value)}
              placeholder="New list name…"
            />
            <button onClick={addList}>Add List</button>
          </div>
        </div>
      </header>

      <main className="main">
        <aside className="sidebar">
          <div className="sideTitle">Lists</div>
          <ul className="listNav">
            {lists.map((l) => (
              <li key={l.id} className={l.id === activeListId ? "active" : ""}>
                <button
                  onClick={() => setActiveListId(l.id)}
                  className={l.name.trim().toLowerCase() === "inbox" ? "inboxBtn" : undefined}
                >
                  {l.name}
                </button>
                <div className="rowActions">
                  <label className="mini">
                    <input
                      type="checkbox"
                      checked={l.autoResetMidnight}
                      onChange={() => toggleListReset(l.id)}
                    />
                    <span title="Auto-clear at midnight">auto</span>
                  </label>
                  <button
                    className="icon"
                    title="Rename"
                    onClick={() => {
                      const name = window.prompt("Rename list:", l.name);
                      if (name !== null) renameList(l.id, name.trim() || l.name);
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    className="icon danger"
                    title="Delete list"
                    onClick={() => {
                      if (window.confirm(`Delete list "${l.name}"?`)) removeList(l.id);
                    }}
                  >
                    🗑️
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        <section
          className="content"
          onPaste={handlePaste}
          onDragOver={handleDragOverPage}
          onDrop={handleDropPage}
        >
          {activeList ? (
            <>
              <div className="listHeader">
                <h2>{activeList.name}</h2>
                <div className="listTools">
                  <button onClick={() => archiveCompleted(activeList.id)} title="Remove completed">
                    Archive Completed
                  </button>
                </div>
              </div>

              <div className="addBar">
                <input
                  ref={inputRef}
                  value={newTask}
                  onChange={(e) => setNewTask(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addTask()}
                  placeholder="Add a task and hit Enter…"
                />
                <button onClick={addTask}>Add</button>
              </div>

              {dndDisabled ? (
                <div className="listsGrid">
                  {filteredLists.map((l) => (
                    <div key={l.id} className={`listPanel ${l.id === activeListId ? "focus" : ""}`}>
                      <div className="panelHead">
                        <div className="panelTitle">{l.name}</div>
                        <div className="panelMeta">
                          <span>{l.tasks.length} items</span>
                          {l.autoResetMidnight && <span className="chip">auto-midnight</span>}
                        </div>
                      </div>
                      <div className="droppable" id={l.id}>
                        {l.tasks.length === 0 && <div className="empty">No tasks</div>}
                        {l.tasks.map((t) => (
                          <SortableTask
                            key={t.id}
                            task={t}
                            isDeleting={deleting.has(t.id)}
                            onToggle={(id) => toggleTask(l.id, id)}
                            onDelete={(id) => deleteTask(l.id, id)}
                            onEdit={(id, patch) => editTask(l.id, id, patch)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragOver={handleDragOver}
                  onDragEnd={handleDragEnd}
                >
                  <div className="listsGrid">
                    {lists.map((l) => (
                      <div key={l.id} className={`listPanel ${l.id === activeListId ? "focus" : ""}`}>
                        <div className="panelHead">
                          <div className="panelTitle">{l.name}</div>
                          <div className="panelMeta">
                            <span>{l.tasks.length} items</span>
                            {l.autoResetMidnight && <span className="chip">auto-midnight</span>}
                          </div>
                        </div>

                        <SortableContext items={l.tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                          <div className="droppable" id={l.id}>
                            {l.tasks.length === 0 && <div className="empty">No tasks</div>}
                            {l.tasks.map((t) => (
                              <SortableTask
                                key={t.id}
                                task={t}
                                isDeleting={deleting.has(t.id)}
                                onToggle={(id) => toggleTask(l.id, id)}
                                onDelete={(id) => deleteTask(l.id, id)}
                                onEdit={(id, patch) => editTask(l.id, id, patch)}
                              />
                            ))}
                          </div>
                        </SortableContext>
                      </div>
                    ))}
                  </div>
                </DndContext>
              )}
            </>
          ) : (
            <div className="emptyState">Create a list to get started.</div>
          )}
        </section>
      </main>

      {/* FULL STYLE (desktop + mobile) */}
      <style>{`
/* ========= FULL STYLE (desktop + mobile) ========= */

/* Base + palettes */
*, *::before, *::after { box-sizing: border-box; }
body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
.wrap { min-height: 100vh; color: var(--text); background: var(--bg-gradient); }

.wrap.dark {
  --bg: #0b0f19;
  --bg2: #0e1426;
  --bg-gradient: linear-gradient(180deg, var(--bg), var(--bg2) 220px);

  --panel: #121a2b;
  --input-bg: #0f172a;
  --droppable-bg: #0d1527;

  --text: #eef2f7;
  --muted: #9fb0c9;
  --line: rgba(255,255,255,.14);

  --btn-bg: #152540;
  --chip-bg: #152748;
  --chip-border: #294b86;

  --accent: #60a5fa;
  --danger: #f87171;

  --font-size: 15.5px;
  --line-height: 1.5;
}
.wrap.light {
  --bg: #f6f7fb;
  --bg2: #ffffff;
  --bg-gradient: linear-gradient(180deg, var(--bg), var(--bg2) 220px);

  --panel: #ffffff;
  --input-bg: #ffffff;
  --droppable-bg: #f8fafc;

  --text: #0f172a;
  --muted: #475569;
  --line: #e2e8f0;

  --btn-bg: #eef2ff;
  --chip-bg: #eef2ff;
  --chip-border: #c7d2fe;

  --danger: #b91c1c;
  --accent: #1f4bb8;

  --font-size: 15px;
  --line-height: 1.45;
}
.wrap { font-size: var(--font-size); line-height: var(--line-height); }

/* Header */
.header {
  display:flex; gap:16px; align-items:center; justify-content:space-between;
  padding:16px 20px; border-bottom:1px solid var(--line);
  position: sticky; top:0;
  background: color-mix(in oklab, var(--bg) 88%, transparent);
  backdrop-filter: blur(6px);
}
.brand { font-weight: 700; letter-spacing: .2px; }
.actions { display:flex; gap:10px; align-items:center; flex-wrap: wrap; }
.toggleTheme {
  padding:8px 12px; border-radius:10px; border:1px solid var(--line);
  background: var(--btn-bg); color: var(--text);
  min-height: 44px; min-width: 44px;
}
.searchBox {
  min-width: 220px;
  background: var(--input-bg); color: var(--text);
  border:1px solid var(--line); padding:9px 10px; border-radius:10px;
  min-height: 44px; font-size: 16px;
}
.searchBox::placeholder { color: color-mix(in oklab, var(--muted) 82%, transparent); }
.ingestControls { display:flex; gap:10px; align-items:center; }
.ingestLabel { display:flex; align-items:center; gap:6px; color: var(--muted); font-size:12px; }
.ingestLabel .prio { background: var(--panel); color: var(--text); border:1px solid var(--line); padding:7px 8px; border-radius:8px; }

.newList input {
  background: var(--input-bg); color: var(--text);
  border:1px solid var(--line); padding:9px 10px; border-radius:10px;
  min-height: 44px; font-size: 16px;
}
.newList input::placeholder { color: color-mix(in oklab, var(--muted) 85%, transparent); }
.newList button {
  margin-left:8px; padding:9px 12px; border-radius:10px; border:1px solid var(--line);
  background: var(--btn-bg); color: var(--text);
  min-height: 44px; min-width: 44px;
}

/* Shell layout */
.main { display:grid; grid-template-columns: 240px 1fr; gap:0; }
.sidebar { border-right:1px solid var(--line); padding:14px; }
.sideTitle { font-size:12px; color:var(--muted); text-transform: uppercase; letter-spacing:.12em; margin-bottom:8px; }
.listNav { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:8px; }
.listNav li { display:flex; align-items:center; justify-content:space-between; gap:8px; }
.listNav li button {
  flex:1; text-align:left; color:var(--text); background: var(--input-bg);
  border:1px solid var(--line); padding:9px 11px; border-radius:10px;
}
.wrap.dark .listNav li.active button { border-color: color-mix(in oklab, var(--accent) 70%, var(--line)); background: #0e1b35; }
.wrap.light .listNav li.active button { border-color: var(--accent); background: #edf2ff; }

.wrap.dark .listNav li .inboxBtn {
  background: #000 !important; color:#fff !important; border-color:#2a2a2a !important;
  box-shadow: 0 0 0 1px rgba(255,255,255,0.05) inset;
}
.wrap.dark .listNav li.active .inboxBtn { border-color:#3a3a3a !important; }
.wrap.dark .listNav li .inboxBtn:hover,
.wrap.dark .listNav li .inboxBtn:focus-visible { border-color:#4b5563 !important; outline:none; }

.rowActions { display:flex; align-items:center; gap:6px; }
.rowActions .icon {
  background: var(--input-bg); border:1px solid var(--line); color:var(--text);
  padding:6px 8px; border-radius:8px;
}
.rowActions .icon.danger { color: color-mix(in oklab, var(--danger) 80%, white); border-color: color-mix(in oklab, var(--danger) 35%, var(--line)); }
.rowActions .mini { display:flex; align-items:center; gap:4px; font-size:12px; color:var(--muted); }

.content { padding:18px; }
.listHeader { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.listHeader h2 { margin:0; font-size:18px; letter-spacing:.2px; }
.listTools button {
  background: var(--btn-bg); color: var(--text); border:1px solid var(--line);
  padding:9px 12px; border-radius:10px; min-height:44px;
}

/* Add bar */
.addBar { display:flex; gap:8px; margin-bottom:12px; }
.addBar input {
  flex:1; background: var(--input-bg); color: var(--text); border:1px solid var(--line);
  padding:11px 12px; border-radius:10px; min-height:44px; font-size:16px;
}
.addBar input::placeholder { color: color-mix(in oklab, var(--muted) 82%, transparent); }
.addBar button {
  padding:11px 12px; border-radius:10px; background: var(--btn-bg); color: var(--text);
  border:1px solid var(--line); min-height:44px; min-width:84px;
}

/* ======= DESKTOP LISTS (flex scroller) ======= */
.listsGrid {
  display: flex;
  gap: 14px;
  overflow-x: auto;
  overflow-y: visible;
  -webkit-overflow-scrolling: touch;
  padding: 6px 4px 12px;
  scroll-snap-type: x mandatory;
  width: 100%;
  min-height: 140px;
  touch-action: pan-x;
}
.listPanel {
  flex: 0 0 clamp(280px, 32vw, 360px);
  max-width: clamp(280px, 32vw, 360px);
  min-width: 280px;
  scroll-snap-align: start;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset;
}
.listPanel.focus { outline: 1px solid color-mix(in oklab, var(--accent) 35%, var(--line)); }
.panelHead { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--line); }
.panelTitle { font-weight:600; }
.panelMeta { display:flex; gap:10px; color:var(--muted); font-size:12px; }
.chip { background: var(--chip-bg); border:1px solid var(--chip-border); padding:2px 6px; border-radius:999px; }

.droppable {
  padding:10px; min-height: 90px; background: var(--droppable-bg);
  border-bottom-left-radius: 14px; border-bottom-right-radius: 14px;
}
.empty { font-size:13px; color:var(--muted); padding:10px; border:1px dashed var(--line); border-radius:10px; text-align:center; }

/* ======= TASK CARD ======= */
.task {
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:10px;
  padding:11px; margin-bottom:9px;
  border:1px solid var(--line); border-radius:12px;
  background: var(--input-bg);
  transition: transform 140ms ease, opacity 180ms ease, background 160ms, box-shadow 160ms;
  animation: fade-in 180ms ease;
  overflow: hidden;
}
.task.appear { animation: fade-in 180ms ease; }
.task.deleting { opacity: 0; transform: scale(.98); }
@keyframes fade-in { from { opacity: 0; transform: translateY(4px);} to { opacity: 1; transform: translateY(0);} }

.taskLeft {
  display:flex; align-items:flex-start; gap:10px;
  flex: 1 1 240px;
  min-width: 0;
}
.taskMain { flex:1; min-width:0; display:flex; flex-direction:column; gap:6px; }

.taskText {
  letter-spacing:.1px;
  white-space: pre-wrap !important;
  word-break: break-word;
  overflow-wrap: anywhere;
}
.taskText.done { text-decoration: line-through; opacity:.8; }

.tagRow { display:flex; flex-wrap:wrap; gap:6px; max-width:100%; }
.tag { font-size:12px; padding:2px 6px; border-radius:999px; background: var(--panel); border:1px solid var(--line); opacity:.9; }

.editBlock { display:flex; flex-direction:column; gap:6px; }
.editText, .editTags {
  background: var(--panel); color: var(--text); border:1px solid var(--line); padding:8px 10px; border-radius:8px;
  min-height:44px; font-size:16px;
}

.taskRight {
  display:flex; align-items:center; gap:8px;
  flex: 0 1 320px;
  margin-left: auto;
  flex-wrap: wrap;
  min-width: 0;
  max-width: 100%;
  justify-content: flex-end;
}
.taskRight > * { flex: 0 0 auto; }

.prio { background: var(--panel); color:var(--text); border:1px solid var(--line); padding:7px 8px; border-radius:8px; min-height:44px; min-width:44px; }
.prio.low { box-shadow: inset 0 0 0 1px color-mix(in oklab, #16a34a 40%, transparent); }
.prio.med { box-shadow: inset 0 0 0 1px color-mix(in oklab, #60a5fa 40%, transparent); }
.prio.high { box-shadow: inset 0 0 0 1px color-mix(in oklab, #f87171 40%, transparent); }

.due {
  background: var(--panel); color:var(--text); border:1px solid var(--line);
  padding:7px 8px; border-radius:8px; min-height:44px; min-width:44px;
  font-size:15px; line-height:1.2;
  width: 11ch; min-width: 9.5ch; max-width: 14ch;
}
.icon { cursor:pointer; background: var(--panel); border:1px solid var(--line); color:var(--text); padding:6px 8px; border-radius:8px; min-height:44px; min-width:44px; }
.icon.danger { color:#f87171; }
.icon.confirm { color:#22c55e; }

.dragHandle {
  cursor: grab;
  background: var(--panel);
  border: 1px solid var(--line);
  color: var(--text);
  padding: 6px 8px;
  border-radius: 8px;
  touch-action: none;
  min-height:44px; min-width:44px;
}
.dragHandle:active { cursor: grabbing; }

.wrap.dark input::placeholder,
.wrap.dark textarea::placeholder { color: #fff; opacity: 0.8; }

/* ======= MOBILE (stack lists and tasks in columns) ======= */
@media (max-width: 768px) {
  .main { grid-template-columns: 1fr; }
  .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
  .actions { gap: 8px; }
  .searchBox { width: 100%; min-width: 0; }

  .listsGrid {
    display: block !important;
    overflow: visible !important;
    padding: 6px 0 12px !important;
    gap: 0 !important;
    scroll-snap-type: none !important;
  }
  .listPanel {
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    border-left: 1px solid var(--line);
    border-right: 1px solid var(--line);
    border-radius: 12px;
    margin: 0 0 12px 0;
    box-shadow: 0 1px 0 rgba(0,0,0,0.04);
  }

  .task {
    flex-direction: column !important;
    align-items: stretch !important;
    gap: 8px !important;
  }
  .taskLeft { flex: 1 1 auto !important; min-width: 0 !important; }
  .taskRight {
    width: 100% !important;
    flex: 0 0 100% !important;
    margin-left: 0 !important;
    justify-content: space-between !important;
    flex-wrap: wrap !important;
    gap: 8px !important;
    min-width: 0 !important;
    max-width: 100% !important;
  }

  .prio, .icon, .dragHandle, .listTools button { min-width: 44px; min-height: 44px; }

  .taskText {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .content { padding-bottom: calc(72px + env(safe-area-inset-bottom)); }
  .addBar {
    position: sticky;
    bottom: calc(8px + env(safe-area-inset-bottom));
    z-index: 20;
    background: color-mix(in oklab, var(--bg2) 85%, transparent);
    backdrop-filter: blur(6px);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 8px;
    margin-bottom: 8px;
  }
  .addBar input { min-height: 44px; font-size: 16px; }
  .addBar button { min-height: 44px; min-width: 84px; }
}
      `}</style>
    </div>
  );
}

