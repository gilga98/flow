/**
 * Timetable PWA Logic
 * - State Management
 * - Storage Sync
 * - Rendering
 * - Gamification
 */

// --- State & Constants ---
const DB_KEY = 'timetable_db';
const DEFAULT_STATE = {
    tasks: [], // { id, title, startTime, endTime, completed, recurrence, days, date, deletedDates: [] }
    notes: [], // { id, content, tags, createdAt }
    user: {
        points: 0,
        streak: 0,
        lastActiveDate: new Date().toISOString().split('T')[0],
        selectedDate: new Date().toISOString().split('T')[0], // Track viewed date
        settings: {
            notificationsEnabled: false,
            darkMode: false
        }
    }
};

let store = loadStore();

// --- Global Selection State ---
let isSelectionMode = false;
let selectedTaskIds = new Set();
let pendingDeleteId = null; // Single task deletion tracking

function setSelectionMode(active) {
    isSelectionMode = active;
    const selectBtn = document.getElementById('select-mode-btn');
    
    if (!active) {
        selectedTaskIds.clear();
        selectBtn.textContent = 'Select';
        selectBtn.classList.remove('bg-primary', 'text-primary-foreground');
    } else {
        selectBtn.textContent = 'Cancel';
        selectBtn.classList.add('bg-primary', 'text-primary-foreground');
    }
    
    updateBulkActions();
    renderUI();
}

// --- Core Functions ---

function loadStore() {
    try {
        const raw = localStorage.getItem(DB_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            // Migrate old tasks
            if (parsed.tasks) {
                parsed.tasks = parsed.tasks.map(task => {
                    if (!task.recurrence) {
                        return { 
                            ...task, 
                            recurrence: 'daily', 
                            days: [0, 1, 2, 3, 4, 5, 6],
                            date: null,
                            deletedDates: []
                        };
                    }
                    if (!task.deletedDates) task.deletedDates = [];
                    return task;
                });
            }
            // Merge with default to ensure new schema fields exist
            return { 
                ...DEFAULT_STATE, 
                ...parsed, 
                user: { 
                    ...DEFAULT_STATE.user, 
                    ...parsed.user, 
                    selectedDate: parsed.user?.selectedDate || DEFAULT_STATE.user.selectedDate,
                    settings: { ...DEFAULT_STATE.user.settings, ...parsed.user?.settings } 
                } 
            };
        }
    } catch (e) {
        console.error('Failed to load store', e);
    }
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
}

function saveStore() {
    localStorage.setItem(DB_KEY, JSON.stringify(store));
    renderUI();
}

function updatePoints(amount) {
    const oldLevel = Math.floor(store.user.points / 100) + 1;
    store.user.points += amount;
    const newLevel = Math.floor(store.user.points / 100) + 1;
    
    // Simple streak logic: if checked in today, increment. (Simplified for MVP)
    const today = new Date().toISOString().split('T')[0];
    if (store.user.lastActiveDate !== today) {
        store.user.streak++;
        store.user.lastActiveDate = today;
    }
    
    saveStore();
    animatePoints(amount);
    
    if (newLevel > oldLevel) {
        triggerLevelUp(newLevel);
    }
}

function triggerLevelUp(lvl) {
    // Show splash animation
    const splash = document.createElement('div');
    splash.className = 'fixed inset-0 z-[100] flex flex-col items-center justify-center bg-background/80 backdrop-blur-md animate-in fade-in duration-500';
    splash.innerHTML = `
        <div class="flex flex-col items-center gap-6 animate-in zoom-in slide-in-from-bottom-12 duration-700">
            <div class="h-32 w-32 bg-primary text-primary-foreground rounded-full flex items-center justify-center shadow-2xl shadow-primary/40 ring-8 ring-primary/20">
                <i data-lucide="crown" class="h-16 w-16"></i>
            </div>
            <div class="text-center space-y-2 px-4">
                <h1 class="text-4xl sm:text-6xl font-black tracking-normal break-words">LEVEL UP!</h1>
                <p class="text-xl font-medium text-muted-foreground">You reached Level ${lvl}</p>
            </div>
            <button id="close-level-up" class="mt-8 px-8 py-3 bg-primary text-primary-foreground rounded-full font-bold shadow-lg hover:scale-105 active:scale-95 transition-all">Keep Flowing</button>
        </div>
    `;
    document.body.appendChild(splash);
    if (window.lucide) lucide.createIcons();
    
    splash.querySelector('#close-level-up').onclick = () => {
        splash.classList.add('animate-out', 'fade-out', 'zoom-out', 'duration-300');
        setTimeout(() => splash.remove(), 300);
    };
    
    // Confetti effect would be cool but keeping it simple with CSS
}

// --- DOM Elements ---
const app = document.getElementById('app');
const themeToggle = document.getElementById('theme-toggle');
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');
const timelineList = document.getElementById('timeline-list');
const notesList = document.getElementById('notes-list');
const currentTaskDisplay = document.getElementById('current-task-display');
const currentTaskTime = document.getElementById('current-task-time');
const pointsValue = document.getElementById('points-value');
const taskCount = document.getElementById('task-count');
const emptyState = document.getElementById('empty-state');

// Modals
const editorModal = document.getElementById('editor-modal');
const editorForm = document.getElementById('editor-form');
const modalCancel = document.getElementById('modal-cancel');
const addTaskBtn = document.getElementById('add-task-btn');
const addNoteBtn = document.getElementById('add-note-btn');

// --- Initialization ---

function init() {
    applyTheme();
    renderUI();
    setupListeners();
    checkNotifications();
    setInterval(updateCurrentTask, 60000); // Update every minute
}

// --- Rendering ---

function renderUI() {
    // 1. Points & Rewards
    pointsValue.textContent = store.user.points;
    const level = Math.floor(store.user.points / 100) + 1;
    const levelProgress = store.user.points % 100;
    
    const levelValue = document.getElementById('level-value');
    const levelProgressBar = document.getElementById('level-progress');
    if (levelValue) levelValue.textContent = level;
    if (levelProgressBar) levelProgressBar.style.width = `${levelProgress}%`;

    // 2. Timeline
    renderWeeklyScroller();
    timelineList.innerHTML = '';
    
    // Filter tasks for the selected date
    const selectedDate = new Date(store.user.selectedDate);
    const selectedDay = selectedDate.getDay();
    const formattedSelectedDate = store.user.selectedDate;

    const filteredTasks = store.tasks.filter(task => {
        if (task.recurrence === 'none') {
            return task.date === formattedSelectedDate;
        } else if (task.recurrence === 'daily') {
            return true;
        } else if (task.recurrence === 'weekdays') {
            return task.days && task.days.includes(selectedDay);
        }
        return false;
    });

    // Sort filtered tasks by time
    const sortedTasks = filteredTasks.sort((a, b) => a.startTime.localeCompare(b.startTime));
    
    // Update task count and date display
    const taskCountEl = document.getElementById('task-count');
    if (taskCountEl) taskCountEl.textContent = sortedTasks.length;
    
    const dateDisplay = document.getElementById('selected-date-display');
    const todayStr = new Date().toISOString().split('T')[0];
    if (dateDisplay) {
        if (formattedSelectedDate === todayStr) {
            dateDisplay.textContent = 'Today';
        } else {
            dateDisplay.textContent = selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
        }
    }

    if (sortedTasks.length === 0) {
        emptyState.classList.remove('hidden');
    } else {
        emptyState.classList.add('hidden');
        if (isSelectionMode) timelineList.classList.add('is-selecting');
        else timelineList.classList.remove('is-selecting');

        sortedTasks.forEach((task, index) => {
            const isCompleted = task.completed;
            const now = new Date();
            const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
            const isToday = formattedSelectedDate === todayStr;
            const isActive = isToday && currentTime >= task.startTime && currentTime <= task.endTime;
            const isSelected = selectedTaskIds.has(task.id);

            // Filter out if this specific date is in deletedDates
            if (task.deletedDates && task.deletedDates.includes(formattedSelectedDate)) return;

            const el = document.createElement('div');
            el.className = `timeline-item relative pl-8 pb-8 transition-all duration-500 animate-in fade-in slide-in-from-bottom-4 ${isCompleted ? 'completed' : ''} ${isActive ? 'active' : ''}`;
            el.style.animationDelay = `${index * 50}ms`;

            el.innerHTML = `
                <div class="timeline-dot"></div>
                <div class="selection-circle ${isSelected ? 'selected' : ''}">
                    <i data-lucide="check" class="h-3 w-3"></i>
                </div>
                <div class="timeline-card group relative bg-card border rounded-2xl p-4 shadow-sm transition-all duration-300 hover:shadow-md hover:border-primary/20 ${isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}" 
                     onclick="handleItemClick(event, '${task.id}')">
                    <div class="flex items-center justify-between gap-4">
                        <div class="flex flex-col gap-1 overflow-hidden pointer-events-none">
                            <div class="flex items-center gap-2">
                                <span class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase py-0.5 px-2 bg-secondary rounded-full">${task.startTime} - ${task.endTime}</span>
                                ${isActive ? '<span class="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse"></span>' : ''}
                                ${task.recurrence !== 'none' ? `<span class="text-[9px] font-bold text-primary/60 uppercase">${task.recurrence === 'daily' ? 'Daily' : 'Repeats'}</span>` : ''}
                            </div>
                            <span class="text-base font-semibold leading-tight truncate ${isCompleted ? 'line-through text-muted-foreground decoration-2' : 'text-foreground'}">${task.title}</span>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <button onclick="toggleTask(event, '${task.id}')" class="h-10 w-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${isSelectionMode ? 'hidden' : ''} ${isCompleted ? 'bg-green-500 text-white border-green-500 shadow-lg shadow-green-500/20 scale-110' : 'bg-background hover:bg-accent border-input hover:border-primary hover:scale-105'}">
                                ${isCompleted ? '<i data-lucide="check" class="h-5 w-5"></i>' : '<i data-lucide="circle" class="h-5 w-5 text-muted-foreground/50"></i>'}
                            </button>
                            <button onclick="openDeleteModal(event, '${task.id}')" class="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full flex items-center justify-center transition-colors ${isSelectionMode ? 'hidden' : ''}">
                                <i data-lucide="trash-2" class="h-4 w-4"></i>
                            </button>
                        </div>
                    </div>
                </div> 
            `;
            timelineList.appendChild(el);
        });
    }

    // 3. Notes
    notesList.innerHTML = '';
    const notesEmptyState = document.getElementById('notes-empty-state');
    
    if (store.notes.length === 0) {
        if (notesEmptyState) notesEmptyState.classList.remove('hidden');
    } else {
        if (notesEmptyState) notesEmptyState.classList.add('hidden');
        store.notes.forEach((note, index) => {
            const el = document.createElement('div');
            el.className = 'group bg-card border rounded-2xl p-5 shadow-sm hover:shadow-md hover:border-primary/20 transition-all duration-300 animate-in fade-in slide-in-from-bottom-4';
            el.style.animationDelay = `${index * 50}ms`;
            el.innerHTML = `
                <div class="flex flex-col gap-3">
                    <p class="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">${note.content}</p>
                    <div class="flex justify-between items-center pt-3 border-t border-border/50">
                        <div class="flex items-center gap-1.5 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            <i data-lucide="calendar" class="h-3 w-3"></i>
                            ${new Date(note.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </div>
                        <button onclick="deleteNote('${note.id}')" class="h-7 w-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full flex items-center justify-center transition-colors">
                            <i data-lucide="trash-2" class="h-3.5 w-3.5"></i>
                        </button>
                    </div>
                </div>
            `;
            notesList.appendChild(el);
        });
    }

    // 4. Current Task
    updateCurrentTask();
    
    // Refresh Icons
    if (window.lucide) lucide.createIcons();
}

function updateCurrentTask() {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const todayDay = now.getDay();
    const todayStr = now.toISOString().split('T')[0];
    
    const current = store.tasks.find(t => {
        const matchesTime = currentTime >= t.startTime && currentTime <= t.endTime;
        if (!matchesTime) return false;
        
        if (t.recurrence === 'none') return t.date === todayStr;
        if (t.recurrence === 'daily') return true;
        if (t.recurrence === 'weekdays') return t.days && t.days.includes(todayDay);
        return false;
    });
    
    if (current) {
        currentTaskDisplay.textContent = current.title;
        currentTaskTime.textContent = `${current.startTime} - ${current.endTime}`;
    } else {
        // Find next task today
        const todayTasks = store.tasks.filter(t => {
            if (t.recurrence === 'none') return t.date === todayStr;
            if (t.recurrence === 'daily') return true;
            if (t.recurrence === 'weekdays') return t.days && t.days.includes(todayDay);
            return false;
        });

        const sortedTasks = todayTasks.sort((a,b) => a.startTime.localeCompare(b.startTime));
        const next = sortedTasks.find(t => t.startTime > currentTime);
        
        if (next) {
            currentTaskDisplay.textContent = "Free Time";
            currentTaskTime.textContent = `Next: ${next.title} at ${next.startTime}`;
        } else {
            // Check if there are any tasks today, if not show the first one tomorrow
            if (sortedTasks.length > 0 && currentTime > sortedTasks[sortedTasks.length-1].endTime) {
                currentTaskDisplay.textContent = "Day Ended";
                currentTaskTime.textContent = "See you tomorrow!";
            } else {
                currentTaskDisplay.textContent = "Flow State";
                currentTaskTime.textContent = "No tasks planned";
            }
        }
    }
}

function renderWeeklyScroller() {
    const scroller = document.getElementById('weekly-scroller');
    if (!scroller) return;
    
    scroller.innerHTML = '';
    
    const today = new Date();
    // Show 14 days (current week + next week)
    for (let i = 0; i < 14; i++) {
        const d = new Date();
        d.setDate(today.getDate() + i);
        
        const dateStr = d.toISOString().split('T')[0];
        const isActive = store.user.selectedDate === dateStr;
        
        const btn = document.createElement('button');
        btn.className = `day-btn ${isActive ? 'active' : ''}`;
        btn.innerHTML = `
            <span class="day-name">${d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
            <span class="day-date">${d.getDate()}</span>
        `;
        btn.onclick = () => {
            store.user.selectedDate = dateStr;
            saveStore();
        };
        scroller.appendChild(btn);
    }
}

function animatePoints(amount) {
    const el = document.getElementById('points-display');
    const val = document.getElementById('points-value');
    
    const isPositive = amount > 0;
    
    // Floating text effect
    const float = document.createElement('div');
    float.className = `fixed font-bold text-sm pointer-events-none transition-all duration-700 z-[100] ${isPositive ? 'text-green-500' : 'text-destructive'}`;
    float.textContent = `${isPositive ? '+' : ''}${amount}`;
    
    const rect = el.getBoundingClientRect();
    float.style.left = `${rect.left + rect.width / 2}px`;
    float.style.top = `${rect.top}px`;
    
    document.body.appendChild(float);
    
    requestAnimationFrame(() => {
        float.style.transform = 'translateY(-40px)';
        float.style.opacity = '0';
    });
    
    setTimeout(() => float.remove(), 700);

    // Bounce animation
    el.classList.add('scale-110', isPositive ? 'bg-green-500/10' : 'bg-destructive/10', isPositive ? 'border-green-500/30' : 'border-destructive/30');
    setTimeout(() => {
        el.classList.remove('scale-110', 'bg-green-500/10', 'bg-destructive/10', 'border-green-500/30', 'border-destructive/30');
    }, 400);
}

// --- Actions ---

window.toggleTask = function(e, id) {
    if (e) e.stopPropagation();
    const task = store.tasks.find(t => t.id === id);
    if (task) {
        task.completed = !task.completed;
        if (task.completed) {
            updatePoints(10); // Reward
        } else {
            updatePoints(-10); // Penalize for unticking
        }
        saveStore();
    }
}

window.handleItemClick = function(e, id) {
    if (isSelectionMode) {
        // Toggle selection state
        if (selectedTaskIds.has(id)) {
            selectedTaskIds.delete(id);
        } else {
            selectedTaskIds.add(id);
        }
        
        // Direct DOM update to avoid full re-render (fixes blinking & race conditions)
        const card = e.currentTarget;
        const selectionCircle = card.parentElement.querySelector('.selection-circle');
        if (selectionCircle) {
            selectionCircle.classList.toggle('selected', selectedTaskIds.has(id));
        }

        updateBulkActions();
        // Removed renderUI() to prevent thrashing
    }
}

window.openDeleteModal = function(e, id) {
    if (e) e.stopPropagation();
    pendingDeleteId = id;
    const task = store.tasks.find(t => t.id === id);
    if (!task) return;

    const modal = document.getElementById('delete-modal');
    const msg = document.getElementById('delete-modal-msg');
    const recurrenceOptions = document.getElementById('recurrence-delete-options');

    if (task.recurrence !== 'none') {
        msg.textContent = `"${task.title}" is a repeating task. How would you like to delete it?`;
        recurrenceOptions.style.display = 'block';
    } else {
        msg.textContent = `Are you sure you want to delete "${task.title}"?`;
        recurrenceOptions.style.display = 'none';
    }

    modal.showModal();
}

window.deleteTask = function(id) {
    // Legacy support or fallback
    openDeleteModal(null, id);
}

function confirmDelete() {
    if (pendingDeleteId) {
        const task = store.tasks.find(t => t.id === pendingDeleteId);
        if (task) {
            const scope = document.querySelector('input[name="delete-scope"]:checked')?.value;
            
            if (task.recurrence === 'none' || scope === 'all') {
                store.tasks = store.tasks.filter(t => t.id !== pendingDeleteId);
            } else {
                // Delete just this occurrence
                if (!task.deletedDates) task.deletedDates = [];
                task.deletedDates.push(store.user.selectedDate);
            }
            saveStore();
        }
        pendingDeleteId = null;
        document.getElementById('delete-modal').close();
    }
}

// --- Bulk Logic ---

function updateBulkActions() {
    const bar = document.getElementById('bulk-action-bar');
    const count = document.getElementById('selected-count');
    
    if (selectedTaskIds.size > 0 && isSelectionMode) {
        bar.classList.add('show');
        count.textContent = selectedTaskIds.size;
    } else {
        bar.classList.remove('show');
    }
}

function bulkDelete() {
    if (selectedTaskIds.size === 0) return;
    
    if (confirm(`Delete ${selectedTaskIds.size} tasks?`)) {
        store.tasks = store.tasks.filter(t => !selectedTaskIds.has(t.id));
        setSelectionMode(false);
        saveStore();
    }
}

// --- Listeners ---

function setupListeners() {
    // Tabs
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // UI Update
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Content Toggle
            const target = btn.dataset.tab;
            tabContents.forEach(c => {
                c.classList.add('hidden');
                c.classList.remove('block');
            });
            const targetEl = document.getElementById(`view-${target}`);
            targetEl.classList.remove('hidden');
            targetEl.classList.add('block');
            
            // Add animation to content
            targetEl.classList.add('animate-in', 'fade-in', 'slide-in-from-bottom-4');
            setTimeout(() => {
                targetEl.classList.remove('animate-in', 'fade-in', 'slide-in-from-bottom-4');
            }, 500);
        });
    });

    // Theme Toggle
    themeToggle.addEventListener('click', () => {
        store.user.settings.darkMode = !store.user.settings.darkMode;
        applyTheme();
        saveStore();
    });

    // Notification Toggle
    const notifyToggle = document.getElementById('notify-toggle');
    notifyToggle.addEventListener('click', () => {
        const enabled = !store.user.settings.notificationsEnabled;
        store.user.settings.notificationsEnabled = enabled;
        notifyToggle.classList.toggle('active', enabled);
        if (enabled) {
            Notification.requestPermission();
        }
        saveStore();
    });
    
    // Initial Notify State
    if (store.user.settings.notificationsEnabled) {
        notifyToggle.classList.add('active');
    }

    // Modal Handling
    let mode = 'task'; // 'task' or 'note'
    
    // Recurrence switch logic
    const recurrenceSelect = document.getElementById('recurrence-select');
    const weekdaySelector = document.getElementById('weekday-selector');
    
    recurrenceSelect.addEventListener('change', (e) => {
        weekdaySelector.style.display = e.target.value === 'weekdays' ? 'block' : 'none';
    });

    // Simple way to handle dialog close on backdrop click since we use fixed position wrapper
    editorModal.addEventListener('click', (e) => {
        if (e.target === editorModal) editorModal.close();
    });

    addTaskBtn.addEventListener('click', () => {
        mode = 'task';
        document.getElementById('modal-title').textContent = 'New Task';
        document.getElementById('task-fields').style.display = 'block';
        document.getElementById('note-fields').style.display = 'none';
        weekdaySelector.style.display = 'none';
        editorForm.reset();
        
        // Default time
        const now = new Date();
        const start = `${String(now.getHours()).padStart(2,'0')}:00`;
        const end = `${String(now.getHours() + 1).padStart(2,'0')}:00`;
        editorForm.startTime.value = start;
        editorForm.endTime.value = end;
        
        editorModal.showModal();
    });

    addNoteBtn.addEventListener('click', () => {
        mode = 'note';
        document.getElementById('modal-title').textContent = 'New Note';
        document.getElementById('task-fields').style.display = 'none';
        document.getElementById('note-fields').style.display = 'block';
        editorForm.reset();
        editorModal.showModal();
    });

    modalCancel.addEventListener('click', () => {
        // Add closing animation if needed, but simple close for now
        editorModal.close();
    });
    
    const closeX = document.getElementById('modal-close-x');
    if(closeX) closeX.addEventListener('click', () => editorModal.close());

    editorForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(editorForm);
        
        if (mode === 'task') {
            const recurrence = formData.get('recurrence');
            const selectedDays = Array.from(formData.getAll('days')).map(Number);
            
            const newTask = {
                id: Date.now().toString(),
                title: formData.get('title'),
                startTime: formData.get('startTime'),
                endTime: formData.get('endTime'),
                completed: false,
                recurrence: recurrence,
                days: recurrence === 'weekdays' ? selectedDays : (recurrence === 'daily' ? [0,1,2,3,4,5,6] : []),
                date: recurrence === 'none' ? store.user.selectedDate : null
            };
            if (newTask.title && newTask.startTime) {
                store.tasks.push(newTask);
                saveStore();
                editorModal.close();
            }
        } else {
            const newNote = {
                id: Date.now().toString(),
                content: formData.get('content'),
                createdAt: new Date().toISOString()
            };
            if (newNote.content) {
                store.notes.unshift(newNote);
                saveStore();
                editorModal.close();
            }
        }
    });

    // Data Export/Import
    document.getElementById('export-btn').addEventListener('click', () => {
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(store));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", `flow_backup_${new Date().toISOString().split('T')[0]}.json`);
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    });

    // Bulk & Selection Mode
    const selectBtn = document.getElementById('select-mode-btn');
    selectBtn.addEventListener('click', () => {
        setSelectionMode(!isSelectionMode);
    });

    document.getElementById('bulk-cancel-btn').addEventListener('click', () => {
        setSelectionMode(false);
    });

    document.getElementById('bulk-delete-btn').addEventListener('click', bulkDelete);

    // Custom Modal Listeners
    document.getElementById('delete-cancel-btn').addEventListener('click', () => {
        document.getElementById('delete-modal').close();
        pendingDeleteId = null;
    });

    document.getElementById('delete-confirm-btn').addEventListener('click', confirmDelete);

    document.getElementById('import-file').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const parsed = JSON.parse(e.target.result);
                store = parsed;
                saveStore();
                alert('Data imported successfully!');
            } catch (err) {
                alert('Invalid JSON file');
            }
        };
        reader.readAsText(file);
    });

    document.getElementById('clear-data-btn').addEventListener('click', () => {
        if(confirm('Are you sure? This will wipe all data permanently.')) {
            localStorage.removeItem(DB_KEY);
            location.reload();
        }
    });
}

function applyTheme() {
    if (store.user.settings.darkMode) {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
}

function checkNotifications() {
    if (!store.user.settings.notificationsEnabled) return;
    
    // Simple check every minute
    setInterval(() => {
        const now = new Date();
        const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        const todayDay = now.getDay();
        const todayStr = now.toISOString().split('T')[0];
        
        const taskStarting = store.tasks.find(t => {
            if (t.startTime !== currentTime) return false;
            
            if (t.recurrence === 'none') return t.date === todayStr;
            if (t.recurrence === 'daily') return true;
            if (t.recurrence === 'weekdays') return t.days && t.days.includes(todayDay);
            return false;
        });
        
        if (taskStarting) {
            showNotification(`Starting: ${taskStarting.title}`, `It's time for ${taskStarting.title}`);
        }
    }, 60000);
}

function showNotification(title, body) {
    if (Notification.permission === 'granted') {
        new Notification(title, { body, icon: '/icon.png' });
    }
}

// Start
init();
