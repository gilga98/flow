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
    hydrationLogs: {}, // { "YYYY-MM-DD": count }
    user: {
        points: 0,
        streak: 0,
        lastActiveDate: new Date().toISOString().split('T')[0],
        selectedDate: new Date().toISOString().split('T')[0], // Track viewed date
        water: {
            // current: 0, // DEPRECATED - moved to hydrationLogs
            goal: 8,
            lastDrink: Date.now(),
            reminders: false
        },
    settings: {
            notificationsEnabled: false,
            darkMode: false,
            wakeTime: '07:00',
            sleepTime: '23:00',
            meals: {
                breakfast: '08:00',
                lunch: '13:00',
                dinner: '20:00'
            }
        }
    },
    weather: {
        data: null, // { temp, code, isDay }
        lastFetched: 0,
        cacheDuration: 1800000 // 30 mins
    },
    rewards: {
        saplings: [], // { id, date, code, claimed }
        dailyPoints: { date: new Date().toISOString().split('T')[0], count: 0 },
        totalPointsEarned: 0 // Lifetime tracking
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
            const merged = { 
                ...DEFAULT_STATE, 
                ...parsed, 
                user: { 
                    ...DEFAULT_STATE.user, 
                    ...parsed.user, 
                    selectedDate: parsed.user?.selectedDate || DEFAULT_STATE.user.selectedDate,
                    water: { ...DEFAULT_STATE.user.water, ...parsed.user?.water },
                    settings: { 
                        ...DEFAULT_STATE.user.settings, 
                        ...parsed.user?.settings,
                        meals: { ...DEFAULT_STATE.user.settings.meals, ...parsed.user?.settings?.meals }
                    } 
                },
                hydrationLogs: parsed.hydrationLogs || {},
                hydrationLogs: parsed.hydrationLogs || {},
                weather: parsed.weather || DEFAULT_STATE.weather,
                rewards: {
                    ...DEFAULT_STATE.rewards,
                    ...parsed.rewards,
                    saplings: parsed.rewards?.saplings || [],
                    dailyPoints: parsed.rewards?.dailyPoints || DEFAULT_STATE.rewards.dailyPoints
                }
            };

            // Migration: Move old water.current to hydrationLogs (if applicable)
            // If we have a 'current' value but no log for today, save it.
            if (parsed.user?.water?.current !== undefined && !merged.hydrationLogs[new Date().toISOString().split('T')[0]]) {
                const today = new Date().toISOString().split('T')[0];
                if (parsed.user.water.date === today) {
                     merged.hydrationLogs[today] = parsed.user.water.current;
                }
            }
            
            return merged;
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


const _k_p = [
    70, 108, 111, 119, 105, 110, 103,
    84, 114, 101, 101, 115,           
    71, 114, 111, 119,                
    70, 97, 115, 116,                 
    50, 48, 50, 54                    
];

function getSecret() {
    return String.fromCharCode(..._k_p);
}

async function generateVerificationCode(id, dateStr) {
    const secret = getSecret();
    const enc = new TextEncoder();
    const keyData = enc.encode(secret);
    const data = enc.encode(`${id}:${dateStr}`);
    
    try {
        const key = await crypto.subtle.importKey(
            "raw", keyData, 
            { name: "HMAC", hash: "SHA-256" }, 
            false, ["sign"]
        );
        
        const sig = await crypto.subtle.sign("HMAC", key, data);
        
        // Convert to Hex
        const sigArray = Array.from(new Uint8Array(sig));
        const sigHex = sigArray.map(b => b.toString(16).padStart(2, '0')).join('');
        
        // Truncate signature to 8 chars for usability (sufficient for anti-gaming in this context)
        // Format: ID|DATE|SIG_FRAGMENT
        return `${id}|${dateStr}|${sigHex.substring(0, 8)}`;
        
    } catch (e) {
        console.error("Crypto Error", e);
        // Fallback for non-secure contexts (should typically not happen in modern PWA)
        return `${id}|${dateStr}|ERR`; 
    }
}

async function updatePoints(amount, source = 'generic', visualSource = null) {
    const today = new Date().toISOString().split('T')[0];
    
    // Daily Reset check
    if (store.rewards.dailyPoints.date !== today) {
        store.rewards.dailyPoints = { date: today, count: 0 };
    }
    
    // Limits (e.g. max 200 pts per day from tasks)
    const DAILY_LIMIT = 200;
    if (amount > 0 && store.rewards.dailyPoints.count >= DAILY_LIMIT && source === 'task') {
        showToast(`Daily limit reached! Come back tomorrow.`, 'info');
        return;
    }
    
    const oldLevel = Math.floor(store.user.points / 100) + 1;
    
    store.user.points += amount;
    if (store.user.points < 0) store.user.points = 0;
    
    if (amount > 0) {
        store.rewards.dailyPoints.count += amount;
        store.rewards.totalPointsEarned += amount;
    }

    // Check for Sapling (Every 1000 points)
    const currentSaplings = store.rewards.saplings.length;
    const calculatedSaplings = Math.floor(store.user.points / 1000);
    
    if (calculatedSaplings > currentSaplings) {
        const newSaplingsCount = calculatedSaplings - currentSaplings;
        for (let i = 0; i < newSaplingsCount; i++) {
            const id = generateId(); // Simple ID for now
            const code = await generateVerificationCode(id, today);
            store.rewards.saplings.push({
                id: (currentSaplings + i + 1).toString().padStart(4, '0'),
                date: new Date().toISOString(),
                code: code,
                claimed: false
            });
            showNotification("New Sapling Planted!", "You've grown enough to plant a tree!");
        }
    }
    
    saveStore();
    
    // Visuals
    animatePoints(amount, visualSource);
    
    const newLevel = Math.floor(store.user.points / 100) + 1;
    if (newLevel > oldLevel) {
        showToast(`Level Up! You are now Level ${newLevel}`, 'success');
        confetti({ particleCount: 100, spread: 70, origin: { y: 0.6 } });
    }
}

function animatePoints(amount, startSource) {
    if (amount <= 0) return;
    const pointsDisplay = document.getElementById('points-display');
    if (!pointsDisplay) return;

    // Create floating element
    const el = document.createElement('div');
    el.textContent = `+${amount}`;
    el.className = 'flying-point';
    
    // Determine start position
    let startX, startY;
    if (startSource instanceof Element) {
        const rect = startSource.getBoundingClientRect();
        startX = rect.left + rect.width / 2;
        startY = rect.top;
    } else if (startSource && startSource.clientX) { // Event
        startX = startSource.clientX;
        startY = startSource.clientY;
    } else {
        // Default to center screen
        startX = window.innerWidth / 2;
        startY = window.innerHeight / 2;
    }

    // Determine target position (header points)
    const targetRect = pointsDisplay.getBoundingClientRect();
    const targetX = targetRect.left + targetRect.width / 2;
    const targetY = targetRect.top + targetRect.height / 2;

    // Calculate translation (delta)
    const tx = targetX - startX;
    const ty = targetY - startY;

    el.style.left = `${startX}px`;
    el.style.top = `${startY}px`;
    el.style.setProperty('--tx', `${tx}px`);
    el.style.setProperty('--ty', `${ty}px`);

    document.body.appendChild(el);

    // Cleanup
    el.addEventListener('animationend', () => el.remove());

    // Pulse target
    setTimeout(() => {
        pointsDisplay.classList.add('scale-110', 'bg-green-100', 'text-green-700');
        setTimeout(() => {
            pointsDisplay.classList.remove('scale-110', 'bg-green-100', 'text-green-700');
        }, 200);
    }, 800); // Sync with animation arrival
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
    setupUtilities();
    setupUtilities();
    checkNotifications();
    checkStartupPermissions();
    
    // Initial checks
    updateGreeting();
    fetchWeather();
    checkWakeUpBounty();
    checkDailyWaterReset();
    
    // Heartbeat every minute
    setInterval(() => {
        updateCurrentTask();
        updateGreeting(); // Update greeting as time changes
        // Ensure these run even if app is left open overnight
        checkWakeUpBounty();
        checkDailyWaterReset();
        checkNotifications();
    }, 60000); 
}

// --- Rendering ---

function renderUI() {
    // 1. Points & Rewards
    const pointsValue = document.getElementById('points-value');
    if (pointsValue) pointsValue.textContent = store.user.points;
    
    const level = Math.floor(store.user.points / 100) + 1;
    const levelProgress = store.user.points % 100;
    
    const levelValue = document.getElementById('level-value');
    const levelProgressBar = document.getElementById('level-progress');
    if (levelValue) levelValue.textContent = level;
    if (levelProgressBar) levelProgressBar.style.width = `${levelProgress}%`;
    
    // Dynamic Icon Logic
    const levelIconWrapper = document.getElementById('level-icon-wrapper');
    if (levelIconWrapper) {
        let iconName = 'seed';
        if (level >= 6) iconName = 'sprout';
        if (level >= 11) iconName = 'tree-deciduous';
        
        // Only update if changed to default prevent flicker, checking inner HTML content roughly
        if (!levelIconWrapper.innerHTML.includes(iconName)) {
            levelIconWrapper.innerHTML = `<i data-lucide="${iconName}" class="h-3 w-3"></i>`;
            if (window.lucide) lucide.createIcons();
        }
    }

    // 2. Timeline
    renderWeeklyScroller();
    renderWeeklyScroller();
    timelineList.innerHTML = '';
    
    // Inject Hydration Widget for Selected Date
    const timelineHydration = document.createElement('div');
    const selectedDateStr = store.user.selectedDate;
    const currentWater = store.hydrationLogs[selectedDateStr] || 0;
    const isTodayForWater = selectedDateStr === new Date().toISOString().split('T')[0];
    
    timelineHydration.className = "mb-6 p-4 rounded-2xl bg-blue-50/50 border border-blue-100 flex items-center justify-between";
    timelineHydration.innerHTML = `
        <div class="flex items-center gap-3">
            <div class="h-10 w-10 rounded-full bg-blue-100/50 flex items-center justify-center text-blue-500">
                <i data-lucide="droplet" class="h-5 w-5 fill-current"></i>
            </div>
            <div>
                 <p class="text-sm font-bold text-foreground">Hydration</p>
                 <p class="text-xs text-muted-foreground font-medium">${currentWater} / ${store.user.water.goal} cups</p>
            </div>
        </div>
        <div class="flex items-center gap-2">
            ${isTodayForWater ? `
            <button onclick="modifyWater(-1)" class="h-8 w-8 rounded-full bg-background border border-border flex items-center justify-center hover:bg-accent transition-colors">
                <i data-lucide="minus" class="h-4 w-4"></i>
            </button>
            <button onclick="modifyWater(1)" class="h-8 w-8 rounded-full bg-blue-500 text-white shadow-lg shadow-blue-500/20 flex items-center justify-center hover:bg-blue-600 transition-colors active:scale-95">
                <i data-lucide="plus" class="h-4 w-4"></i>
            </button>
            ` : `
            <span class="text-xs font-bold text-muted-foreground bg-secondary px-3 py-1 rounded-full">History</span>
            `}
        </div>
    `;
    timelineList.appendChild(timelineHydration);
    
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

        // Cluster tasks for horizontal layout (handling conflict/overlaps)
        const clusters = [];
        let currentCluster = [];
        let clusterEndTime = "00:00";

        sortedTasks.forEach(task => {
            // Filter out deleted dates first
            if (task.deletedDates && task.deletedDates.includes(formattedSelectedDate)) return;

            // Check overlap: Task starts before current cluster ends
            if (currentCluster.length > 0 && task.startTime < clusterEndTime) {
                currentCluster.push(task);
                if (task.endTime > clusterEndTime) clusterEndTime = task.endTime;
            } else {
                if (currentCluster.length > 0) clusters.push(currentCluster);
                currentCluster = [task];
                clusterEndTime = task.endTime;
            }
        });
        if (currentCluster.length > 0) clusters.push(currentCluster);

        // Render Clusters
        clusters.forEach((cluster, clusterIndex) => {
            const isMulti = cluster.length > 1;
            const now = new Date();
            const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
            const isToday = formattedSelectedDate === todayStr;

            // Shared Group Status
            const groupIsActive = isToday && cluster.some(t => currentTime >= t.startTime && currentTime <= t.endTime);
            const groupIsCompleted = cluster.every(t => t.completed);

            // Container matches "timeline-item" structure
            // If multi: Use a scrollable container for cards
            // If single: Standard rendering
            
            const wrapper = document.createElement('div');
            // 'overflow-hidden' on wrapper prevents any vertical scroll leak from children if configured badly, 
            // but we need 'visible' for dots if they pop out? Actually dots are inside.
            wrapper.className = `timeline-item relative pl-8 pb-8 transition-all duration-500 animate-in fade-in slide-in-from-bottom-4 ${groupIsCompleted ? 'completed' : ''} ${groupIsActive ? 'active' : ''}`;
            wrapper.style.animationDelay = `${clusterIndex * 50}ms`;

            // Shared Timeline Dot
            // Helper to see if we should show primary dot (if group active or any task inside has special icon/state?)
            // For now, if active, show active dot.
            const dot = document.createElement('div');
            dot.className = `timeline-dot ${groupIsActive ? 'bg-primary border-primary' : ''}`;
            wrapper.appendChild(dot);

            if (isMulti) {
                // Horizontal Scroll Container
                const scrollContainer = document.createElement('div');
                // Added overflow-y-hidden vs jitter
                scrollContainer.className = "flex gap-3 w-full overflow-x-auto pb-2 px-1 snap-x snap-mandatory no-scrollbar";
                // Prevent vertical scroll pass-through
                scrollContainer.style.overflowY = "hidden";
                scrollContainer.style.touchAction = "pan-x"; 

                cluster.forEach((task) => {
                    const isCompleted = task.completed;
                    const isActive = isToday && currentTime >= task.startTime && currentTime <= task.endTime;
                    const isSelected = selectedTaskIds.has(task.id);
                    const iconName = getTaskIcon(task.title);

                    const cardWrapper = document.createElement('div');
                    cardWrapper.className = `flex-none w-[90%] sm:w-[48%] snap-start relative`;

                    cardWrapper.innerHTML = `
                        <div class="selection-circle ${isSelected ? 'selected' : ''}" style="${isSelected || isSelectionMode ? 'display: flex;' : ''} top: 50%; transform: translateY(-50%); left: -10px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                            <i data-lucide="check" class="h-3 w-3"></i>
                        </div>
                        <div class="timeline-card group relative bg-card border rounded-2xl p-4 shadow-sm transition-all duration-300 hover:shadow-md hover:border-primary/20 ${isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}" 
                            onclick="handleItemClick(event, '${task.id}')">
                            <div class="flex items-center justify-between gap-4">
                                <div class="flex flex-col gap-1 overflow-hidden pointer-events-none">
                                    <div class="flex items-center gap-2">
                                        <span class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase py-0.5 px-2 bg-secondary rounded-full flex items-center gap-1 whitespace-nowrap overflow-hidden text-ellipsis max-w-full">
                                            ${iconName ? `<i data-lucide="${iconName}" class="h-3 w-3"></i>` : ''}
                                            ${task.startTime} - ${task.endTime}
                                        </span>
                                        ${isActive ? '<span class="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0"></span>' : ''}
                                    </div>
                                    <span class="text-base font-semibold leading-tight truncate ${isCompleted ? 'line-through text-muted-foreground decoration-2' : 'text-foreground'}">${task.title}</span>
                                </div>
                                <div class="flex items-center gap-2 shrink-0">
                                    <button onclick="toggleTask(event, '${task.id}')" class="h-10 w-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${isSelectionMode ? 'hidden' : ''} ${isCompleted ? 'bg-green-500 text-white border-green-500 shadow-lg shadow-green-500/20 scale-110' : 'bg-background hover:bg-accent border-input hover:border-primary hover:scale-105'}">
                                        ${isCompleted ? '<i data-lucide="check" class="h-5 w-5"></i>' : '<i data-lucide="circle" class="h-5 w-5 text-muted-foreground/50"></i>'}
                                    </button>
                                </div>
                            </div>
                        </div> 
                    `;
                    scrollContainer.appendChild(cardWrapper);
                });
                wrapper.appendChild(scrollContainer);
            } else {
                // Single Item (Original Logic slightly cleaned up)
                const task = cluster[0];
                const isCompleted = task.completed;
                const isActive = groupIsActive; // Same for single
                const isSelected = selectedTaskIds.has(task.id);
                const iconName = getTaskIcon(task.title);

                // Helper for selection circle logic in standard view
                // We use standard .selection-circle classes from CSS
                wrapper.innerHTML += `
                    <div class="selection-circle ${isSelected ? 'selected' : ''}">
                        <i data-lucide="check" class="h-3 w-3"></i>
                    </div>
                    <div class="timeline-card group relative bg-card border rounded-2xl p-4 shadow-sm transition-all duration-300 hover:shadow-md hover:border-primary/20 ${isActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}" 
                        onclick="handleItemClick(event, '${task.id}')">
                        <div class="flex items-center justify-between gap-4">
                            <div class="flex flex-col gap-1 overflow-hidden pointer-events-none">
                                <div class="flex items-center gap-2">
                                    <span class="text-[10px] font-bold tracking-wider text-muted-foreground uppercase py-0.5 px-2 bg-secondary rounded-full flex items-center gap-1 whitespace-nowrap overflow-hidden text-ellipsis max-w-full">
                                        ${iconName ? `<i data-lucide="${iconName}" class="h-3 w-3"></i>` : ''}
                                        ${task.startTime} - ${task.endTime}
                                    </span>
                                    ${isActive ? '<span class="flex h-1.5 w-1.5 rounded-full bg-primary animate-pulse shrink-0"></span>' : ''}
                                    ${task.recurrence !== 'none' ? `<span class="text-[9px] font-bold text-primary/60 uppercase shrink-0">${task.recurrence === 'daily' ? 'Daily' : 'Repeats'}</span>` : ''}
                                </div>
                                <span class="text-base font-semibold leading-tight truncate ${isCompleted ? 'line-through text-muted-foreground decoration-2' : 'text-foreground'}">${task.title}</span>
                            </div>
                            <div class="flex items-center gap-2 shrink-0">
                                <button onclick="toggleTask(event, '${task.id}')" class="h-10 w-10 rounded-full flex items-center justify-center border-2 transition-all duration-300 ${isSelectionMode ? 'hidden' : ''} ${isCompleted ? 'bg-green-500 text-white border-green-500 shadow-lg shadow-green-500/20 scale-110' : 'bg-background hover:bg-accent border-input hover:border-primary hover:scale-105'}">
                                    ${isCompleted ? '<i data-lucide="check" class="h-5 w-5"></i>' : '<i data-lucide="circle" class="h-5 w-5 text-muted-foreground/50"></i>'}
                                </button>
                                <button onclick="openFocusMode('${task.id}')" class="hidden sm:flex h-8 w-8 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-full items-center justify-center transition-colors ${isSelectionMode ? 'hidden' : ''}" title="Focus">
                                    <i data-lucide="target" class="h-4 w-4"></i>
                                </button>
                                <button onclick="openDeleteModal(event, '${task.id}')" class="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-full flex items-center justify-center transition-colors ${isSelectionMode ? 'hidden' : ''}">
                                    <i data-lucide="trash-2" class="h-4 w-4"></i>
                                </button>
                            </div>
                        </div>
                    </div> 
                `;
            }

            timelineList.appendChild(wrapper);
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
    
    // Get all tasks for today
    const todayTasks = store.tasks.filter(t => {
        if (t.deletedDates && t.deletedDates.includes(todayStr)) return false;
        
        if (t.recurrence === 'none') return t.date === todayStr;
        if (t.recurrence === 'daily') return true;
        if (t.recurrence === 'weekdays') return t.days && t.days.includes(todayDay);
        return false;
    });
    
    const sortedTasks = todayTasks.sort((a,b) => a.startTime.localeCompare(b.startTime));

    const current = sortedTasks.find(t => {
        return currentTime >= t.startTime && currentTime <= t.endTime;
    });
    
    // Check for Day Complete (All tasks defined for today are marked completed)
    const allDone = todayTasks.length > 0 && todayTasks.every(t => t.completed);

    if (current) {
        currentTaskDisplay.textContent = current.title;
        currentTaskTime.textContent = `${current.startTime} - ${current.endTime}`;
        
        if (current.completed) {
             currentTaskDisplay.innerHTML = `<span class="line-through opacity-50">${current.title}</span> <span class="text-xs align-middle bg-green-500/10 text-green-500 px-2 py-0.5 rounded-full no-underline ml-2">Done</span>`;
        }
    } else if (allDone) {
        currentTaskDisplay.textContent = "Day Complete";
        currentTaskTime.textContent = "See you tomorrow!";
    } else {
        // Find next task today
        const next = sortedTasks.find(t => t.startTime > currentTime);
        
        if (next) {
            currentTaskDisplay.textContent = "Free Time";
            currentTaskTime.textContent = `Next: ${next.title} at ${next.startTime}`;
        } else {
            // No current task, no next task. 
            // Check if day has ended (time is past last task)
            if (sortedTasks.length > 0 && currentTime > sortedTasks[sortedTasks.length-1].endTime) {
                 // Even if allDone is false (meaning some were skipped/not checked), if we are past the last task time:
                 const anyLeft = sortedTasks.some(t => !t.completed);
                 if (!anyLeft) {
                     // This block might be redundant with allDone check above, but keeps logic safe for edge cases
                    currentTaskDisplay.textContent = "Day Complete";
                    currentTaskTime.textContent = "Great job today!";
                 } else {
                    currentTaskDisplay.textContent = "Day Ended";
                    currentTaskTime.textContent = "Unfinished tasks remain";
                 }
            } else {
                currentTaskDisplay.textContent = "Flow State";
                currentTaskTime.textContent = "No tasks planned";
            }
        }
    }
}

function updateGreeting() {
    const greetingEl = document.getElementById('greeting-text');
    const dateEl = document.getElementById('full-date-display');
    if (!greetingEl) return;
    
    const now = new Date();
    const hrs = now.getHours();
    let text = 'Good Morning';
    
    if (hrs >= 12 && hrs < 17) text = 'Good Afternoon';
    else if (hrs >= 17) text = 'Good Evening';
    
    // Add User Name logic later if needed
    greetingEl.textContent = text;
    
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, options);
}

function fetchWeather() {
    const widget = document.getElementById('weather-widget');
    if (!widget) return;
    
    // Cache Check
    const now = Date.now();
    if (store.weather && store.weather.data && (now - store.weather.lastFetched < store.weather.cacheDuration)) {
        renderWeather(store.weather.data);
        return;
    }

    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(async (position) => {
        try {
            const { latitude, longitude } = position.coords;
            // Using Open-Meteo (Free, No Key)
            const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current_weather=true`);
            const data = await res.json();
            
            if (data.current_weather) {
                const weatherData = {
                    temp: Math.round(data.current_weather.temperature),
                    code: data.current_weather.weathercode,
                    isDay: data.current_weather.is_day
                };
                
                store.weather.data = weatherData;
                store.weather.lastFetched = Date.now();
                saveStore();
                renderWeather(weatherData);
            }
        } catch (e) {
            console.error('Weather fetch failed', e);
        }
    }, (err) => {
        console.log('Geo permission denied used', err);
    });
}

function renderWeather(data) {
    const widget = document.getElementById('weather-widget');
    const tempEl = document.getElementById('weather-temp');
    const iconEl = document.getElementById('weather-icon');
    const descEl = document.getElementById('weather-desc');
    
    widget.classList.remove('hidden');
    widget.classList.add('flex');
    
    tempEl.textContent = `${data.temp}°`;
    
    // Simple Mapping
    // 0: Clear, 1-3: Cloudy, 45-48: Fog, 51-67: Rain, 71-77: Snow, 80-82: Rain, 95-99: Storm
    const code = data.code;
    let icon = 'sun';
    let desc = 'Clear';
    let color = 'text-orange-500';
    
    if (code > 0 && code <= 3) { icon = 'cloud-sun'; desc = 'Cloudy'; color = 'text-yellow-500'; }
    else if (code >= 45 && code <= 48) { icon = 'cloud-fog'; desc = 'Foggy'; color = 'text-gray-400'; }
    else if (code >= 51 && code <= 67) { icon = 'cloud-rain'; desc = 'Rain'; color = 'text-blue-400'; }
    else if (code >= 71 && code <= 77) { icon = 'snowflake'; desc = 'Snow'; color = 'text-blue-200'; }
    else if (code >= 80 && code <= 82) { icon = 'cloud-drizzle'; desc = 'Showers'; color = 'text-blue-400'; }
    else if (code >= 95) { icon = 'cloud-lightning'; desc = 'Storm'; color = 'text-purple-500'; }
    
    if (data.isDay === 0 && code === 0) { icon = 'moon'; color = 'text-indigo-300'; desc = 'Clear Night'; }
    
    iconEl.setAttribute('data-lucide', icon);
    iconEl.className = `h-6 w-6 ${color} fill-current/20`;
    descEl.textContent = desc;
    
    if (window.lucide) lucide.createIcons();
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

// --- Actions ---

window.toggleTask = function(e, id) {
    if (e) e.stopPropagation();
    const task = store.tasks.find(t => t.id === id);
    if (task) {
        task.completed = !task.completed;
        
        if (task.completed) {
        } else {
            // Unchecking - deduct points if they were likely awarded?
            // Simplification: Always deduct 10 to keep balance, but don't go negative on daily cap logic (handled in updatePoints)
            updatePoints(-10); 
        }
        saveStore();
    }
}

// New: Rewards Profile
window.openRewardsProfile = function() {
    const modal = document.getElementById('rewards-modal');
    if (!modal) return;
    
    // Stats
    const total = store.user.points;
    const currentSaplings = store.rewards.saplings.length;
    
    // Logic: Each sapling every 1000 points.
    // Progress is within the current 1000 chunk.
    const progressPercent = (total % 1000) / 10; 
    const nextMilestone = (Math.floor(total / 1000) + 1) * 1000;
    const needed = nextMilestone - total;

    // UI Elements
    const progressFill = document.getElementById('sapling-progress-fill');
    const nextText = document.getElementById('sapling-next-text');
    const countDisplay = document.getElementById('sapling-count-display');
    
    if (progressFill) progressFill.style.width = `${progressPercent}%`;
    if (nextText) nextText.textContent = `${needed} pts to new sapling`;
    if (countDisplay) countDisplay.textContent = `${currentSaplings} Sapling${currentSaplings !== 1 ? 's' : ''}`;
    
    renderForestGrid();
    
    modal.showModal();
    document.body.style.overflow = 'hidden';
}

function renderForestGrid() {
    const grid = document.getElementById('forest-grid');
    if (!grid) return;
    
    grid.innerHTML = '';
    const saplings = store.rewards.saplings;
    
    if (saplings.length === 0) {
        // Empty State in Grid
        grid.className = "flex flex-col items-center justify-center p-8 bg-muted/30 rounded-2xl border border-dashed border-border/60 min-h-[150px] gap-2";
        grid.innerHTML = `
            <i data-lucide="sprout" class="h-8 w-8 text-muted-foreground/30"></i>
            <span class="text-xs text-muted-foreground/50 font-medium">No saplings yet. Keep growing!</span>
        `;
    } else {
        grid.className = "grid grid-cols-5 gap-2 min-h-[100px] p-4 bg-muted/30 rounded-2xl border border-dashed border-border/60 justify-items-center";
        saplings.forEach(s => {
            const el = document.createElement('button');
            el.className = "h-10 w-10 rounded-full bg-green-100 text-green-600 flex items-center justify-center hover:scale-110 transition-transform shadow-sm relative group";
            el.onclick = () => copySaplingCode(s.code);
            el.innerHTML = `
                <i data-lucide="tree-deciduous" class="h-5 w-5"></i>
                <div class="absolute -bottom-8 left-1/2 -translate-x-1/2 z-20 bg-popover text-popover-foreground text-[10px] px-2 py-1 rounded shadow-md opacity-0 group-hover:opacity-100 pointer-events-none whitespace-nowrap transition-opacity">
                    #${s.id} • ${new Date(s.date).toLocaleDateString()}
                </div>
            `;
            grid.appendChild(el);
        });
    }
    if (window.lucide) lucide.createIcons();
}

window.toggleRewardInfo = function() {
    const card = document.getElementById('reward-info-card');
    if (card) {
        card.classList.toggle('hidden');
    }
}

window.viewSaplingHistory = function() {
    // For now, toggle visibility or switch view. 
    // MVP: Just show toast. Real history log could be a separate modal or view.
    showToast('Full history coming soon! Check your Forest Grid.', 'info');
}



window.copySaplingCode = function(code) {
    navigator.clipboard.writeText(code).then(() => {
        showToast('Confirmation code copied! Share it with us.', 'success');
    });
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
            showToast('Task deleted', 'success');
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
        showToast('Tasks deleted', 'success');
    }
}

window.deleteNote = function(id) {
    if(confirm('Delete this note?')) {
        store.notes = store.notes.filter(n => n.id !== id);
        saveStore();
        showToast('Note deleted', 'success');
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
        showToast(store.user.settings.darkMode ? 'Dark mode enabled' : 'Light mode enabled');
    });

    // Notification Toggle
    const notifyToggle = document.getElementById('notify-toggle');
    notifyToggle.addEventListener('click', () => {
        const enabled = !store.user.settings.notificationsEnabled;
        store.user.settings.notificationsEnabled = enabled;
        notifyToggle.classList.toggle('active', enabled);
        if (enabled) {
            Notification.requestPermission();
            showToast('Notifications enabled', 'success');
        } else {
            showToast('Notifications disabled');
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
                date: recurrence === 'none' ? store.user.selectedDate : null,
                createdAt: Date.now()
            };
            if (newTask.title && newTask.startTime) {
                store.tasks.push(newTask);
                saveStore();
                editorModal.close();
                showToast('Task added successfully', 'success');
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
                showToast('Note added successfully', 'success');
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
                showToast('Data imported successfully!', 'success');
            } catch (err) {
                showToast('Invalid JSON file', 'error');
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

    // Routine Settings
    const wakeInput = document.getElementById('setting-wake-time');
    const sleepInput = document.getElementById('setting-sleep-time');
    
    if (wakeInput) {
        wakeInput.value = store.user.settings.wakeTime || '07:00';
        wakeInput.addEventListener('change', (e) => {
            store.user.settings.wakeTime = e.target.value;
            saveStore();
        });
    }

    if (sleepInput) {
        sleepInput.value = store.user.settings.sleepTime || '23:00';
        sleepInput.addEventListener('change', (e) => {
            store.user.settings.sleepTime = e.target.value;
            saveStore();
        });
    }

    const addMealBtn = document.getElementById('add-meal-schedule-btn');
    if (addMealBtn) {
        addMealBtn.addEventListener('click', addMealSchedule);
    }

    // Meal Times Inputs
    ['breakfast', 'lunch', 'dinner'].forEach(meal => {
        const input = document.getElementById(`setting-meal-${meal}`);
        if (input) {
            input.value = store.user.settings.meals?.[meal] || DEFAULT_STATE.user.settings.meals[meal];
            input.addEventListener('change', (e) => {
                if (!store.user.settings.meals) store.user.settings.meals = {};
                store.user.settings.meals[meal] = e.target.value;
                saveStore();
            });
        }
    });

    // Rewards Modal Scroll Cleanup
    const rewardsModal = document.getElementById('rewards-modal');
    if (rewardsModal) {
        rewardsModal.addEventListener('close', () => {
            document.body.style.overflow = '';
        });
    }
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
    
    // Single check (called by main loop)
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const todayDay = now.getDay();
    const todayStr = now.toISOString().split('T')[0];
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    // Find ALL tasks starting now or in 5 mins
    const tasksStarting = store.tasks.filter(t => {
        if (t.deletedDates && t.deletedDates.includes(todayStr)) return false;

        // Check time match (Exact)
        if (t.startTime === currentTime) {
            if (t.recurrence === 'none') return t.date === todayStr;
            if (t.recurrence === 'daily') return true;
            if (t.recurrence === 'weekdays') return t.days && t.days.includes(todayDay);
        }
        
        // Check 5 Minute Warning
        const [h, m] = t.startTime.split(':').map(Number);
        const taskMinutes = h * 60 + m;
        
        // Need to verify taskMinutes is valid (e.g., crossing midnight)
        // For MVP, assuming single-day tasks. 
        if (taskMinutes - currentMinutes === 5) {
             if (t.recurrence === 'none') return t.date === todayStr;
             if (t.recurrence === 'daily') return true;
             if (t.recurrence === 'weekdays') return t.days && t.days.includes(todayDay);
        }
        
        return false;
    });
    
    tasksStarting.forEach(task => {
        const [h, m] = task.startTime.split(':').map(Number);
        const taskMinutes = h * 60 + m;
        
        // Prevent duplicate notifications? (Basic debounce could be added here if needed, but per-minute check is usually fine)
        if (taskMinutes - currentMinutes === 5) {
            showNotification(`Up Next: ${task.title}`, `Starting in 5 minutes (${task.startTime})`);
        } else {
            showNotification(`Starting: ${task.title}`, `It's time for ${task.title}`);
        }
    });

    // Water Reminder
    if (store.user.water.reminders) {
        const lastDrink = store.user.water.lastDrink || 0;
        // 1 hour = 3600000 ms
        if (Date.now() - lastDrink > 3600000) {
                // Only remind if active hours (e.g. 9am to 9pm) to avoid sleep disturbance
                const hour = now.getHours();
                if (hour >= 9 && hour <= 21) {
                    
                    // Check if already reached goal?
                    const current = store.hydrationLogs[todayStr] || 0;
                    if (current >= store.user.water.goal) return; // Don't nag if goal met

                    if (now.getMinutes() === 0) {
                        showNotification("Time to Hydrate 💧", "You haven't logged water in an hour.");
                    }
                }
        }
    }

    // Sleep Reminder
    if (store.user.settings.notificationsEnabled && store.user.settings.sleepTime) {
            const sleepTime = store.user.settings.sleepTime;
            const [h, m] = sleepTime.split(':').map(Number);
            const sleepDate = new Date();
            sleepDate.setHours(h, m, 0, 0);
            
            // Remind 30 mins before
            const remindDate = new Date(sleepDate.getTime() - 30 * 60000);
            const remindTime = `${String(remindDate.getHours()).padStart(2,'0')}:${String(remindDate.getMinutes()).padStart(2,'0')}`;
            
            if (currentTime === remindTime) {
                showNotification("Wind Down Time 🌙", "Your target sleep time is in 30 minutes.");
            }
    }
}

function showNotification(title, body) {
    if (Notification.permission === 'granted') {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
             navigator.serviceWorker.ready.then(registration => {
                registration.showNotification(title, {
                    body: body,
                    icon: 'logo-square.svg', // Updated icon
                    vibrate: [200, 100, 200],
                    badge: 'logo-square.svg',
                    tag: title // Simple dedup tag
                });
            });
        } else {
            const n = new Notification(title, { body, icon: 'logo-square.svg', tag: title });
            n.onclick = () => { n.close(); window.focus(); };
        }
    }
    // Also show toast inside app if visible
    if (!document.hidden) {
        showToast(`${title}: ${body}`, 'info');
    }
}

window.testNotification = function() {
    if (Notification.permission === 'granted') {
        showNotification("Test Notification", "If you see this, notifications are working!");
    } else {
        Notification.requestPermission().then(perm => {
             if (perm === 'granted') showNotification("Test Notification", "Notifications enabled!");
             else showToast("Permission denied. Check browser settings.", "error");
        });
    }
}

function checkStartupPermissions() {
    // Only check if we haven't checked recently to avoid annoyed (or use session storage)
    if (Notification.permission === 'default' && !sessionStorage.getItem('perm_dismissed')) {
        // Create a persistent sticky banner
        const banner = document.createElement('div');
        banner.className = "fixed bottom-6 left-4 right-4 z-[200] max-w-sm mx-auto bg-primary text-primary-foreground p-4 rounded-xl shadow-2xl flex items-center justify-between animate-in slide-in-from-bottom-10";
        banner.innerHTML = `
            <div class="flex items-center gap-3">
                <i data-lucide="bell-ring" class="h-5 w-5 animate-pulse"></i>
                <div class="text-sm font-bold">Enable notifications?</div>
            </div>
            <div class="flex items-center gap-2">
                 <button id="perm-later" class="text-xs opacity-80 hover:opacity-100 px-2 py-1">Later</button>
                 <button id="perm-enable" class="text-xs font-bold bg-background text-foreground px-3 py-1.5 rounded-lg shadow-sm hover:scale-105 transition-all">Enable</button>
            </div>
        `;
        document.body.appendChild(banner);
        if (window.lucide) lucide.createIcons();
        
        document.getElementById('perm-enable').onclick = () => {
            Notification.requestPermission().then(res => {
                if (res === 'granted') {
                    store.user.settings.notificationsEnabled = true;
                    saveStore();
                    showNotification("You're all set!", "Notifications enabled.");
                }
                banner.classList.add('animate-out', 'fade-out', 'slide-out-to-bottom-10');
                setTimeout(() => banner.remove(), 500);
            });
        };
        document.getElementById('perm-later').onclick = () => {
            sessionStorage.setItem('perm_dismissed', 'true');
            banner.classList.add('animate-out', 'fade-out', 'slide-out-to-bottom-10');
            setTimeout(() => banner.remove(), 500);
        };
    }
}

function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    
    let icon = 'info';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'alert-circle';
    
    toast.innerHTML = `
        <i data-lucide="${icon}" class="h-5 w-5 ${type === 'success' ? 'text-green-500' : type === 'error' ? 'text-destructive' : 'text-primary'}"></i>
        <span class="text-sm font-medium">${message}</span>
    `;
    
    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();
    
    setTimeout(() => {
        toast.classList.add('toast-closing');
        toast.addEventListener('animationend', () => toast.remove());
    }, duration);
}

// --- Utilities Logic ---

let timerInterval = null;
let timerState = {
    timeLeft: 1500, // 25 mins
    totalTime: 1500,
    isActive: false,
    taskId: null // Linked task
};

const BREATH_PHASES = [
    { text: 'Inhale', duration: 4000, scale: 1.5, opacity: 1 },
    { text: 'Hold', duration: 4000, scale: 1.5, opacity: 0.8 },
    { text: 'Exhale', duration: 4000, scale: 1, opacity: 0.5 },
    { text: 'Hold', duration: 4000, scale: 1, opacity: 0.8 }
];
let breathState = {
    active: false,
    phaseIndex: 0,
    timeout: null
};

window.openFocusMode = function(taskId) {
    // 1. Switch to Utilities tab
    document.querySelector('[data-tab="utilities"]').click();
    document.getElementById('util-tab-focus').click();

    // 2. Setup Task
    const task = store.tasks.find(t => t.id === taskId);
    if (task) {
        timerState.taskId = taskId;
        document.getElementById('timer-task-label').innerHTML = `Focusing on: <span class="text-primary font-bold">${task.title}</span>`;
    } else {
        timerState.taskId = null;
        document.getElementById('timer-task-label').textContent = "Ready to Focus?";
    }
}

function setupUtilities() {
    // Sub-tabs
    const focusBtn = document.getElementById('util-tab-focus');
    const breathBtn = document.getElementById('util-tab-breath');
    const focusView = document.getElementById('util-focus');
    const breathView = document.getElementById('util-breath');

    focusBtn.addEventListener('click', () => {
        focusBtn.classList.remove('text-muted-foreground', 'bg-transparent');
        focusBtn.classList.add('bg-background', 'text-foreground', 'shadow-sm');
        
        breathBtn.classList.add('text-muted-foreground', 'bg-transparent');
        breathBtn.classList.remove('bg-background', 'text-foreground', 'shadow-sm');
        
        focusView.classList.remove('hidden');
        breathView.classList.add('hidden');
    });

    breathBtn.addEventListener('click', () => {
        breathBtn.classList.remove('text-muted-foreground', 'bg-transparent');
        breathBtn.classList.add('bg-background', 'text-foreground', 'shadow-sm');
        
        focusBtn.classList.add('text-muted-foreground', 'bg-transparent');
        focusBtn.classList.remove('bg-background', 'text-foreground', 'shadow-sm');

        breathView.classList.remove('hidden');
        focusView.classList.add('hidden');
    });

    // Timer Controls
    document.getElementById('timer-toggle-btn').addEventListener('click', toggleTimer);
    document.getElementById('timer-reset-btn').addEventListener('click', resetTimer);
    document.getElementById('timer-finish-btn').addEventListener('click', finishTimer);

    document.querySelectorAll('.timer-preset').forEach(btn => {
        btn.addEventListener('click', () => {
            const mins = parseInt(btn.dataset.time);
            setTimerDuration(mins * 60);
            
            // UI Update
            document.querySelectorAll('.timer-preset').forEach(b => b.removeAttribute('data-active'));
            btn.setAttribute('data-active', 'true');
        });
    });

    // Breath Controls
    document.getElementById('breath-toggle-btn').addEventListener('click', toggleBreathing);

    // Water Controls
    setupWater();
}

// -- Timer Functions --

function setTimerDuration(seconds) {
    if (timerState.isActive) return; // Block while running
    timerState.timeLeft = seconds;
    timerState.totalTime = seconds;
    updateTimerUI();
}

function updateTimerBtnIcon(name) {
    const btn = document.getElementById('timer-toggle-btn');
    btn.innerHTML = `<i data-lucide="${name}" class="h-10 w-10 fill-current pl-1"></i>`;
    if (window.lucide) window.lucide.createIcons();
}

function toggleTimer() {
    timerState.isActive = !timerState.isActive;
    if (timerState.isActive) {
        updateTimerBtnIcon('pause');
        document.getElementById('timer-finish-btn').classList.remove('opacity-50', 'pointer-events-none');
        timerInterval = setInterval(() => {
            if (timerState.timeLeft > 0) {
                timerState.timeLeft--;
                updateTimerUI();
            } else {
                finishTimer();
            }
        }, 1000);
    } else {
        updateTimerBtnIcon('play');
        clearInterval(timerInterval);
    }
}

function resetTimer() {
    clearInterval(timerInterval);
    timerState.isActive = false;
    timerState.timeLeft = timerState.totalTime;
    
    updateTimerBtnIcon('play');
    document.getElementById('timer-finish-btn').classList.add('opacity-50', 'pointer-events-none');
    
    updateTimerUI();
}

function finishTimer() {
    clearInterval(timerInterval);
    timerState.isActive = false;
    timerState.timeLeft = 0;
    updateTimerUI();
    
    // Reset UI state
    // Reset UI state
    updateTimerBtnIcon('play');
    document.getElementById('timer-finish-btn').classList.add('opacity-50', 'pointer-events-none');

    // Reward
    updatePoints(50);
    showNotification("Focus Session Complete", "Great job! +50 points.");

    // Prompt for task completion
    if (timerState.taskId) {
        if(confirm(`Mark linked task as complete?`)) {
            toggleTask(null, timerState.taskId);
        }
    }
    
    // Sound (Beep)
    const audio = new Audio('https://actions.google.com/sounds/v1/alarms/beep_short.ogg');
    audio.play().catch(e => console.log('Audio play failed', e));
    
    // Reset to default after a moment
    setTimeout(() => {
        timerState.timeLeft = timerState.totalTime;
        updateTimerUI();
    }, 2000);
}

function updateTimerUI() {
    const mins = Math.floor(timerState.timeLeft / 60);
    const secs = timerState.timeLeft % 60;
    document.getElementById('timer-display').textContent = 
        `${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}`;
        
    // Ring Progress
    const ring = document.getElementById('timer-ring');
    const circumference = 289;
    const offset = circumference - (timerState.timeLeft / timerState.totalTime) * circumference;
    ring.style.strokeDashoffset = offset;
    
    // Color shift based on progress
    if (timerState.timeLeft < 60) {
        ring.classList.add('text-destructive');
        ring.classList.remove('text-primary');
    } else {
        ring.classList.remove('text-destructive');
        ring.classList.add('text-primary');
    }
}

// -- Breath Functions --

function toggleBreathing() {
    const btn = document.getElementById('breath-toggle-btn');
    const guide = document.getElementById('breath-guide');
    
    if (breathState.active) {
        // Stop
        breathState.active = false;
        clearTimeout(breathState.timeout);
        btn.textContent = "Start Breathing";
        btn.classList.remove('bg-muted', 'text-foreground');
        btn.classList.add('bg-primary', 'text-primary-foreground');
        
        // Reset UI
        updateBreathUI('Ready', 1, 1);
        guide.textContent = "Take a deep breath...";
    } else {
        // Start
        breathState.active = true;
        btn.textContent = "Stop";
        btn.classList.remove('bg-primary', 'text-primary-foreground');
        btn.classList.add('bg-muted', 'text-foreground');
        guide.textContent = "Follow the rhythm...";
        runBreathCycle();
    }
}

function runBreathCycle() {
    if (!breathState.active) return;
    
    const phase = BREATH_PHASES[breathState.phaseIndex];
    updateBreathUI(phase.text, phase.scale, phase.opacity);
    
    breathState.timeout = setTimeout(() => {
        breathState.phaseIndex = (breathState.phaseIndex + 1) % BREATH_PHASES.length;
        runBreathCycle();
    }, phase.duration);
}

function updateBreathUI(text, scale, opacity) {
    const circle = document.getElementById('breath-circle');
    const label = document.getElementById('breath-text');
    const bv = document.getElementById('breath-circle-bv');
    
    label.style.opacity = '0';
    setTimeout(() => {
        label.textContent = text;
        label.style.opacity = '1';
    }, 200);
    
    circle.style.transform = `scale(${scale})`;
    circle.style.borderColor = `rgba(var(--primary), ${opacity})`;
    bv.style.transform = `scale(${scale * 1.2})`;
}

// -- Water Functions --

function setupWater() {
    const waterBtn = document.getElementById('util-tab-water');
    const waterView = document.getElementById('util-water');
    const focusView = document.getElementById('util-focus');
    const breathView = document.getElementById('util-breath');
    const focusBtn = document.getElementById('util-tab-focus');
    const breathBtn = document.getElementById('util-tab-breath');

    // Tab Switching
    waterBtn.addEventListener('click', () => {
        // Reset others
        [focusBtn, breathBtn].forEach(b => {
             b.classList.add('text-muted-foreground', 'bg-transparent');
             b.classList.remove('bg-background', 'text-foreground', 'shadow-sm');
        });
        
        waterBtn.classList.remove('text-muted-foreground', 'bg-transparent');
        waterBtn.classList.add('bg-background', 'text-foreground', 'shadow-sm');
        
        focusView.classList.add('hidden');
        breathView.classList.add('hidden');
        waterView.classList.remove('hidden');
        
        updateWaterUI();
    });

    // Add/Remove (Utility Tab)
    document.getElementById('water-add-btn').addEventListener('click', () => {
        // Utility tab always operates on "Today" conceptually, 
        // but let's route it through the same modifyWater logic.
        // Ensure selected date is today before calling? 
        // Or just let modifyWater enforce it (which requires selectedDate=Today).
        // Let's force switch to today if they use the utility tab, or just act on today regardless of view?
        // Safest: Act on TODAY regardless of selectedDate in timeline.
        
        const today = new Date().toISOString().split('T')[0];
        if (!store.hydrationLogs[today]) store.hydrationLogs[today] = 0;
        store.hydrationLogs[today]++;
        store.user.water.lastDrink = Date.now();
        
        if (store.hydrationLogs[today] === store.user.water.goal) {
            updatePoints(20);
            showNotification("Hydration Goal Met!", "Great job staying hydrated! +20 points");
        }
        saveStore();
    });

    document.getElementById('water-remove-btn').addEventListener('click', () => {
        const today = new Date().toISOString().split('T')[0];
        if (store.hydrationLogs[today] && store.hydrationLogs[today] > 0) {
            store.hydrationLogs[today]--;
            saveStore();
        }
    });

    // Notify Toggle
    const toggle = document.getElementById('water-notify-toggle');
    
    // Init state
    if (store.user.water.reminders) {
        toggle.classList.add('active');
    }

    toggle.addEventListener('click', () => {
        store.user.water.reminders = !store.user.water.reminders;
        const isActive = store.user.water.reminders;
        
        toggle.classList.toggle('active', isActive);
        if (isActive) {
             Notification.requestPermission();
        }
        saveStore();
    });
    
    // Check daily reset
    checkDailyWaterReset();
}

function updateWaterUI() {
    // Utility Tab UI
    const today = new Date().toISOString().split('T')[0];
    const current = store.hydrationLogs[today] || 0;
    const goal = store.user.water.goal;
    
    const countEl = document.getElementById('water-count');
    const goalEl = document.getElementById('water-goal');
    const levelEl = document.getElementById('water-level');

    if(countEl) countEl.textContent = current;
    if(goalEl) goalEl.textContent = goal;
    
    if(levelEl) {
        const percentage = Math.min((current / goal) * 100, 100);
        levelEl.style.height = `${percentage}%`;
    }
}

window.modifyWater = function(amount) {
    const today = new Date().toISOString().split('T')[0];
    
    // Allow modifying current selected date if it is today, OR just force today?
    // User requested "per day basis". If they are on a past date in timeline, the widget shows history.
    // The buttons only appear if selectedDate == today.
    // So this function acts on store.user.selectedDate which MUST be today if buttons are clicked.
    // Safety check:
    if (store.user.selectedDate !== today) return;

    if (!store.hydrationLogs[today]) store.hydrationLogs[today] = 0;
    
    if (amount < 0 && store.hydrationLogs[today] <= 0) return;
    
    store.hydrationLogs[today] += amount;
    store.user.water.lastDrink = Date.now();
    
    // Reward
    if (amount > 0 && store.hydrationLogs[today] === store.user.water.goal) {
        updatePoints(20);
        showNotification("Hydration Goal Met!", "Great job staying hydrated! +20 points");
    }
    
    saveStore();
}

function checkDailyWaterReset() {
    // No longer strictly needed for "resetting" a counter, 
    // but we can ensure the key exists for consistency?
    // Actually, with the new log system, we just read hydrationLogs[today].
    // If it's undefined, it's effectively 0.
    // So this function can just be a no-op or used for other maintenance.
}

// -- Phase 3 Logic: Balance --

function getTaskIcon(title) {
    const t = title.toLowerCase();
    if (t.includes('lunch') || t.includes('dinner') || t.includes('breakfast') || t.includes('food') || t.includes('meal')) return 'utensils';
    if (t.includes('coffee') || t.includes('tea')) return 'coffee';
    if (t.includes('sleep') || t.includes('nap') || t.includes('bed')) return 'moon';
    if (t.includes('wake') || t.includes('morning')) return 'sun';
    if (t.includes('gym') || t.includes('run') || t.includes('workout') || t.includes('exercise')) return 'dumbbell';
    if (t.includes('work') || t.includes('code') || t.includes('meeting') || t.includes('job')) return 'briefcase';
    if (t.includes('study') || t.includes('read') || t.includes('book')) return 'book-open';
    if (t.includes('game') || t.includes('play')) return 'gamepad-2';
    return null; // Fallback
}

function checkWakeUpBounty() {
    const today = new Date().toISOString().split('T')[0];
    const now = new Date();
    const wakeTime = store.user.settings.wakeTime || '07:00';
    
    // Check if within 1 hour of wake time
    const [wakeH, wakeM] = wakeTime.split(':').map(Number);
    const targetTime = new Date();
    targetTime.setHours(wakeH, wakeM, 0, 0);
    
    const diffMins = (now - targetTime) / 60000;
    
    // Logic: If check-in is between WakeTime and WakeTime+60m
    // AND we haven't collected bounty today
    if (diffMins >= 0 && diffMins <= 60) {
        if (store.user.lastBountyDate !== today) {
            store.user.lastBountyDate = today;
            updatePoints(100);
            
            // Show special splash
             const splash = document.createElement('div');
            splash.className = 'fixed inset-0 z-[100] flex flex-col items-center justify-center bg-yellow-400/20 backdrop-blur-md animate-in fade-in duration-500';
            splash.innerHTML = `
                <div class="flex flex-col items-center gap-6 animate-in zoom-in slide-in-from-bottom-12 duration-700">
                    <div class="h-32 w-32 bg-yellow-400 text-yellow-900 rounded-full flex items-center justify-center shadow-2xl shadow-yellow-500/40 ring-8 ring-yellow-400/20">
                        <i data-lucide="sun" class="h-16 w-16"></i>
                    </div>
                    <div class="text-center space-y-2 px-4">
                        <h1 class="text-4xl sm:text-6xl font-black tracking-tight text-yellow-500 drop-shadow-sm">MORNING GLORY!</h1>
                        <p class="text-xl font-bold text-foreground">You woke up on time.</p>
                        <p class="text-lg font-medium text-muted-foreground">+100 Points</p>
                    </div>
                    <button class="mt-8 px-8 py-3 bg-foreground text-background rounded-full font-bold shadow-lg hover:scale-105 active:scale-95 transition-all" onclick="this.parentElement.parentElement.remove()">Start the Day</button>
                </div>
            `;
            document.body.appendChild(splash);
            if(window.lucide) lucide.createIcons();
            saveStore();
        }
    }
}

function addMealSchedule() {
    const mealSettings = store.user.settings.meals || DEFAULT_STATE.user.settings.meals;
    const meals = [
        { title: 'Breakfast', time: mealSettings.breakfast, duration: 30 },
        { title: 'Lunch', time: mealSettings.lunch, duration: 45 },
        { title: 'Dinner', time: mealSettings.dinner, duration: 45 }
    ];
    
    let addedCount = 0;
    meals.forEach(m => {
        // Prevent Duplicates
        // Check if a daily recurring task with same title already exists
        const exists = store.tasks.some(t => 
            t.title === m.title && 
            t.recurrence === 'daily' &&
            !t.deletedDates.includes(new Date().toISOString().split('T')[0])
        );
        
        if (exists) return;

        const [h, min] = m.time.split(':').map(Number);
        const endD = new Date();
        endD.setHours(h, min + m.duration, 0, 0);
        const endTime = `${String(endD.getHours()).padStart(2,'0')}:${String(endD.getMinutes()).padStart(2,'0')}`;
        
        const newTask = {
            id: Date.now().toString() + Math.random(),
            title: m.title,
            startTime: m.time,
            endTime: endTime,
            completed: false,
            recurrence: 'daily',
            days: [0,1,2,3,4,5,6],
            date: null,
            deletedDates: [],
            createdAt: Date.now()
        };
        store.tasks.push(newTask);
        addedCount++;
    });
    
    if (addedCount > 0) {
        saveStore();
        showToast(`Added ${addedCount} recurring meal tasks!`, 'success');
    } else {
        showToast('Meal tasks already added!', 'info');
    }
}

// --- PWA Install Logic ---

let deferredPrompt;
const installBanner = document.getElementById('install-banner');
const installBtn = document.getElementById('install-btn');
const dismissBtn = document.getElementById('install-dismiss-btn');

// Check if already installed (standalone mode)
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone || document.referrer.includes('android-app://');
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

if (!isStandalone) {
    if (isIos) {
        showInstallBanner();
        if (installBanner) {
            const p = installBanner.querySelector('p');
            if (p) p.textContent = "Tap Share and select 'Add to Home Screen'";
            if (installBtn) installBtn.style.display = 'none';
        }
    } else {
        window.addEventListener('beforeinstallprompt', (e) => {
            // Prevent the mini-infobar from appearing on mobile
            e.preventDefault();
            // Stash the event so it can be triggered later.
            deferredPrompt = e;
            // Update UI notify the user they can install the PWA
            showInstallBanner();
        });
    }
}

function showInstallBanner() {
    if (installBanner) {
        // Only show if not dismissed recently? For now, just show.
        installBanner.classList.remove('translate-y-32');
    }
}

if (installBtn) {
    installBtn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        // Hide the app provided install promotion
        if (installBanner) installBanner.classList.add('translate-y-32');
        // Show the install prompt
        deferredPrompt.prompt();
        // Wait for the user to respond to the prompt
        const { outcome } = await deferredPrompt.userChoice;
        console.log(`User response to the install prompt: ${outcome}`);
        // We've used the prompt, and can't use it again, throw it away
        deferredPrompt = null;
    });
}

if (dismissBtn) {
    dismissBtn.addEventListener('click', () => {
        if (installBanner) installBanner.classList.add('translate-y-32');
    });
}

window.addEventListener('appinstalled', () => {
    // Hide the app-provided install promotion
    if (installBanner) installBanner.classList.add('translate-y-32');
    // Clear the deferredPrompt so it can be garbage collected
    deferredPrompt = null;
    showToast('App installed successfully!', 'success');
});

// Start the app
init();
