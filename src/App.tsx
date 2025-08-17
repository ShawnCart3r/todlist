import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
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
  tags: string[];         // NEW
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
 * Utilities & storage
 * =========================== */
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const loadLists = (): ListsState => {
  try {
    const raw = localStorage.getItem("todo.multilists.v2"); // bump key
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};
const saveLists = (lists: ListsState) => {
  try {
    localStorage.setItem("todo.multilists.v2", JSON.stringify(lists));
  } catch {}
};

const loadLastResetDate = () => localStorage.getItem("todo.lastResetDate.v1") || "";
const saveLastResetDate = (d: string) => localStorage.setItem("todo.lastResetDate.v1", d);

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
      {...attributes}
      {...listeners}
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
  const [search, setSearch] = useState(""); // NEW global search
  const inputRef = useRef<HTMLInputElement>(null);

  // Deleting animation queue (ids fading out)
  const [deleting, setDeleting] = useState<Set<ID>>(new Set());

  // THEME
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("todo.theme") as "dark" | "light") || "dark"
  );
  useEffect(() => localStorage.setItem("todo.theme", theme), [theme]);

  // persist lists
  useEffect(() => saveLists(lists), [lists]);

  // ensure activeListId exists
  useEffect(() => {
    if (!lists.find((l) => l.id === activeListId) && lists[0]) setActiveListId(lists[0].id);
  }, [lists, activeListId]);

  // Optional midnight auto-clear
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
    const t = setInterval(resetIfNeeded, 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // DnD
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
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
    // fade out first
    setDeleting((prev) => new Set(prev).add(taskId));
    setTimeout(() => {
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

  const findListByName = (name: string) =>
    lists.find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase()) || null;

  const getOrCreateListByName = (name: string) => {
    const hit = findListByName(name);
    if (hit) return hit.id;
    const id = uid();
    setLists((ls) => [...ls, { id, name, tasks: [], autoResetMidnight: false }]);
    return id;
  };

  const ensureTodayId = () => getOrCreateListByName("Today");
  const ensureInboxId = () => getOrCreateListByName("Inbox");

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

    // Forced target overrides grouping
    const forcedListId =
      target === "inbox" ? ensureInboxId()
      : target === "today" ? ensureTodayId()
      : target === "active" ? (activeList?.id ?? ensureInboxId())
      : null;

    if (forcedListId) {
      return { [forcedListId]: lines.map(makeTask) };
    }

    if (mode === "single") {
      const lid = activeList?.id ?? ensureInboxId();
      return { [lid]: lines.map(makeTask) };
    }

    // GROUP mode (auto headings)
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
    if (ingestTarget === "today") setActiveListId(ensureTodayId());
    else if (ingestTarget === "inbox") setActiveListId(ensureInboxId());
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
    if (ingestTarget === "today") setActiveListId(ensureTodayId());
    else if (ingestTarget === "inbox") setActiveListId(ensureInboxId());
  }

  /* ---------------------------
   * Search / filter
   * --------------------------- */
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

  // When searching, we still show all lists but tasks are filtered.
  const filteredLists = useMemo(() => {
    if (queryTokens.length === 0) return lists;
    return lists.map((l) => ({ ...l, tasks: l.tasks.filter(taskMatches) }));
  }, [lists, queryTokens]);

  const dndDisabled = queryTokens.length > 0; // safer UX: disable reordering while filtered

  /* ---------------------------
   * Render
   * --------------------------- */
  return (
    <div className={`wrap ${theme}`}>
      <header className="header">
        <div className="brand">🗂️ Multi-List To-Do</div>

        <div className="actions">
          {/* Search */}
          <input
            className="searchBox"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search (text or #tag)…"
            title="Search tasks across lists"
          />

          {/* Ingest controls */}
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

          {/* Theme + New list */}
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
                      const name = prompt("Rename list:", l.name);
                      if (name !== null) renameList(l.id, name.trim() || l.name);
                    }}
                  >
                    ✏️
                  </button>
                  <button
                    className="icon danger"
                    title="Delete list"
                    onClick={() => {
                      if (confirm(`Delete list "${l.name}"?`)) removeList(l.id);
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

              {/* When searching, disable DnD to avoid confusing reorder behavior on filtered views */}
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
                          <div key={t.id}>
                            <SortableTask
                              task={t}
                              isDeleting={deleting.has(t.id)}
                              onToggle={(id) => toggleTask(l.id, id)}
                              onDelete={(id) => deleteTask(l.id, id)}
                              onEdit={(id, patch) => editTask(l.id, id, patch)}
                            />
                          </div>
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
                              <div key={t.id}>
                                <SortableTask
                                  task={t}
                                  isDeleting={deleting.has(t.id)}
                                  onToggle={(id) => toggleTask(l.id, id)}
                                  onDelete={(id) => deleteTask(l.id, id)}
                                  onEdit={(id, patch) => editTask(l.id, id, patch)}
                                />
                              </div>
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

      {/* THEME & UI STYLES */}
      <style>{`
  *, *::before, *::after { box-sizing: border-box; }
  body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "Helvetica Neue", Arial; }
  .wrap { min-height: 100vh; color: var(--text); background: var(--bg-gradient); }

  /* ---------- Dark palette ---------- */
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

  /* ---------- Light palette ---------- */
  .wrap.light {
    --bg: #f6f7fb;
    --bg2: #ffffff;
    --bg-gradient: linear-gradient(180deg, var(--bg), var(--bg2) 220px);
    --panel: #ffffff;
    --text: #0f172a;
    --muted: #475569;
    --line: #e2e8f0;
    --btn-bg: #eef2ff;
    --input-bg: #ffffff;
    --droppable-bg: #f8fafc;
    --chip-bg: #eef2ff;
    --chip-border: #c7d2fe;
    --danger: #b91c1c;
    --accent: #1f4bb8;
    --font-size: 15px;
    --line-height: 1.45;
  }

  .wrap { font-size: var(--font-size); line-height: var(--line-height); }

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
  }
  .searchBox {
    min-width: 220px;
    background: var(--input-bg); color: var(--text);
    border:1px solid var(--line); padding:9px 10px; border-radius:10px;
  }
  .searchBox::placeholder { color: color-mix(in oklab, var(--muted) 82%, transparent); }

  .ingestControls { display:flex; gap:10px; align-items:center; }
  .ingestLabel { display:flex; align-items:center; gap:6px; color: var(--muted); font-size:12px; }
  .ingestLabel .prio { background: var(--panel); color: var(--text); border:1px solid var(--line); padding:7px 8px; border-radius:8px; }

  .newList input {
    background: var(--input-bg); color: var(--text);
    border:1px solid var(--line); padding:9px 10px; border-radius:10px;
  }
  .newList input::placeholder { color: color-mix(in oklab, var(--muted) 85%, transparent); }
  .newList button {
    margin-left:8px; padding:9px 12px; border-radius:10px; border:1px solid var(--line);
    background: var(--btn-bg); color: var(--text);
  }

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

  /* Inbox pops in dark mode */
  .wrap.dark .listNav li .inboxBtn {
    background: #000 !important;
    color: #fff !important;
    border-color: #2a2a2a !important;
    box-shadow: 0 0 0 1px rgba(255,255,255,0.05) inset;
  }
  .wrap.dark .listNav li.active .inboxBtn {
    background: #000 !important;
    color: #fff !important;
    border-color: #3a3a3a !important;
  }
  .wrap.dark .listNav li .inboxBtn:hover,
  .wrap.dark .listNav li .inboxBtn:focus-visible {
    border-color: #4b5563 !important;
    outline: none;
  }

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
    padding:9px 12px; border-radius:10px;
  }

  .addBar { display:flex; gap:8px; margin-bottom:12px; }
  .addBar input {
    flex:1; background: var(--input-bg); color: var(--text); border:1px solid var(--line);
    padding:11px 12px; border-radius:10px;
  }
  .addBar input::placeholder { color: color-mix(in oklab, var(--muted) 82%, transparent); }
  .addBar button {
    padding:11px 12px; border-radius:10px; background: var(--btn-bg); color: var(--text);
    border:1px solid var(--line);
  }

  .listsGrid { display:grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap:14px; align-items:start; }
  .listPanel { border:1px solid var(--line); border-radius:14px; background: var(--panel);
               box-shadow: 0 1px 0 rgba(255,255,255,0.03) inset; }
  .listPanel.focus { outline: 1px solid color-mix(in oklab, var(--accent) 35%, var(--line)); }
  .panelHead { display:flex; align-items:center; justify-content:space-between; padding:10px 12px; border-bottom:1px solid var(--line); }
  .panelTitle { font-weight:600; }
  .panelMeta { display:flex; gap:10px; color:var(--muted); font-size:12px; }
  .chip { background: var(--chip-bg); border:1px solid var(--chip-border); padding:2px 6px; border-radius:999px; }

  .droppable { padding:10px; min-height: 90px; background: var(--droppable-bg);
               border-bottom-left-radius: 14px; border-bottom-right-radius: 14px; }
  .empty { font-size:13px; color:var(--muted); padding:10px; border:1px dashed var(--line); border-radius:10px; text-align:center; }

  .task {
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding:11px; margin-bottom:9px; border:1px solid var(--line); border-radius:12px;
    background: var(--input-bg);
    transition: transform 140ms ease, opacity 180ms ease, background 160ms, box-shadow 160ms;
    animation: fade-in 180ms ease;
  }
  .task.appear { animation: fade-in 180ms ease; }
  .task.deleting { opacity: 0; transform: scale(.98); }

  @keyframes fade-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .taskLeft { display:flex; align-items:flex-start; gap:10px; }
  .taskMain { display:flex; flex-direction:column; gap:6px; }
  .taskText { letter-spacing:.1px; }
  .taskText.done { text-decoration: line-through; opacity:.8; }
  .tagRow { display:flex; flex-wrap:wrap; gap:6px; }
  .tag { font-size:12px; padding:2px 6px; border-radius:999px; background: var(--panel); border:1px solid var(--line); opacity:.9; }

  .editBlock { display:flex; flex-direction:column; gap:6px; }
  .editText, .editTags {
    background: var(--panel); color: var(--text); border:1px solid var(--line); padding:8px 10px; border-radius:8px;
  }

  .taskRight { display:flex; align-items:center; gap:8px; }
  .prio { background: var(--panel); color:var(--text); border:1px solid var(--line); padding:7px 8px; border-radius:8px; }
  .prio.low { box-shadow: inset 0 0 0 1px color-mix(in oklab, #16a34a 40%, transparent); }
  .prio.med { box-shadow: inset 0 0 0 1px color-mix(in oklab, #60a5fa 40%, transparent); }
  .prio.high { box-shadow: inset 0 0 0 1px color-mix(in oklab, #f87171 40%, transparent); }
  .due { background: var(--panel); color:var(--text); border:1px solid var(--line); padding:7px 8px; border-radius:8px; }
  .icon { cursor:pointer; background: var(--panel); border:1px solid var(--line); color:var(--text); padding:6px 8px; border-radius:8px; }
  .icon.danger { color:#f87171; }
  .icon.confirm { color:#22c55e; }

  /* Brighter placeholders in dark mode */
  .wrap.dark input::placeholder,
  .wrap.dark textarea::placeholder { color: #fff; opacity: 0.8; }

  @media (max-width: 880px) {
    .main { grid-template-columns: 1fr; }
    .sidebar { border-right: none; border-bottom: 1px solid var(--line); }
    .actions { flex-wrap: wrap; }
    .searchBox { min-width: 0; width: 100%; }
  }
`}</style>
    </div>
  );
}

