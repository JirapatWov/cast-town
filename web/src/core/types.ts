// Real Life Terminal — web module contracts. Every web module codes against these interfaces;
// web/src/main.ts wires the concrete implementations together.
import type * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type {
  ActivityEntry, AgentInfo, ApprovalRequest, ChatThread, CityState, ClientMsg, GitSummary, Job, LibraryWorkflow, ModelInfo, Project,
  ProviderStatus, RoomRef, ServerMsg, SpendTotals, TeamPlan, TranscriptItem, Workflow, WorkflowRun,
} from '../../../shared/protocol';

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export type ViewName = 'city' | 'house' | 'drive';

// ───────────── Event bus (3D ⇄ UI ⇄ main) ─────────────
export interface BusEvents {
  'building:click': { projectId: string }; // a project building in the city was clicked (or Enter pressed near it while driving)
  'building:hover': { projectId: string | null };
  'lot:click': { lotId: string }; // an empty "For Sale" lot was clicked → UI opens the place-project dialog
  'landmark:click': { landmarkId: string }; // e.g. 'agency' → UI opens Models & Providers panel
  'person:click': { agentId: string }; // a person inside a house → UI opens chat for that agent
  'tv:click': { projectId: string }; // TV in the living room → UI opens the diff viewer
  'board:click': { projectId: string }; // job board / corkboard → UI opens the workflow panel
  'computer:click': { projectId: string }; // a desk computer → UI opens a plain shell in the project folder
  'door:click': { projectId: string }; // front door from inside → go back to the city
  'nav:enter': { projectId: string }; // request: enter this house (main handles transition)
  'nav:city': {}; // request: go back to city overview
  'nav:drive': {}; // request: start driving
  'nav:flyto': { projectId?: string; landmarkId?: string }; // request: city camera flies to a building
  'view:changed': { view: ViewName; projectId?: string }; // emitted by main after a transition completes
  'quality:change': { quality: Quality };
  'focusmode:change': { on: boolean }; // focus mode: 3D paused/dimmed, 2D panels fill the screen
  // Jobs / rooms / floors (see shared/house-plan.ts)
  'room:click': { projectId: string; floor: number; slot: number }; // a room (plate, door or floor) in the house: occupied → select its job, empty → new-job dialog for that room
  'job:select': { projectId: string; jobId: string }; // the UI selected a job → main: house.focusRoom(job.room)
  'floor:show': { floor: number }; // request: the house shows this floor (floor switcher)
  'floor:changed': { projectId: string; floor: number }; // emitted by the house after a floor switch completes
  'placement:start': { lotId?: string }; // UI asks city to highlight empty lots for picking
  'placement:end': {};
}

export interface Bus {
  on<K extends keyof BusEvents>(k: K, fn: (p: BusEvents[K]) => void): () => void;
  emit<K extends keyof BusEvents>(k: K, p: BusEvents[K]): void;
}

// ───────────── Client store (mirrors server state) ─────────────
export interface ClientState {
  connected: boolean;
  hello: Extract<ServerMsg, { t: 'hello' }> | null;
  city: CityState;
  agents: Record<string, AgentInfo>;
  transcripts: Record<string, TranscriptItem[]>;
  /** Workflows every house sees: none from this server (an older one sent its built-ins here, or every workflow).
   *  What one house sees: store.workflowsOf(projectId) (shared/house-workflows.ts). */
  workflows: Workflow[];
  /** Each house's own workflows (house id → them). undefined from an older server. */
  houseWorkflows?: Record<string, Workflow[]>;
  /** The shared library: any house imports a copy. undefined from an older server (it has none). */
  library?: LibraryWorkflow[];
  runs: Record<string, WorkflowRun>;
  approvals: Record<string, ApprovalRequest>;
  /** Plan cards waiting for Run / Cancel, by plan id (answered ones leave; their card stays in the lead's chat). */
  plans: Record<string, TeamPlan>;
  models: ModelInfo[];
  providers: ProviderStatus[];
  git: Record<string, GitSummary>;
  jobs: Record<string, Job[]>; // by projectId, ordered by room (floor, slot)
  threads: Record<string, ChatThread[]>; // by agentId, newest first (filled on demand via list_threads)
  view: ViewName;
  currentProjectId: string | null;
  /** The job the panels act on in the current house (chat roster, workflow tab). null → the project's 'main' job. */
  currentJobId: string | null;
  /** The server session's spend ledger (never goes down); undefined from servers that don't keep one. */
  spend?: SpendTotals;
  /** The house activity log, newest first (the Inbox's "Recent"); undefined from servers that don't keep one. */
  activity?: ActivityEntry[];
}

export interface RequestOptions {
  /** A long request (a job's own copy being made, brought in or deleted) is still unanswered after a while: show a
   *  "still working" state. Never called once it settled. */
  onSlow?(): void;
}

export interface Store {
  readonly state: ClientState;
  /** Called after every applied server message (msg) or local state change (msg undefined). */
  subscribe(fn: (s: ClientState, msg?: ServerMsg) => void): () => void;
  send(msg: ClientMsg): void;
  /** Sends a message with a fresh reqId and resolves with the matching ack / fs_list reply. */
  request<T = unknown>(msg: ClientMsg & { reqId: string }, opts?: RequestOptions): Promise<T>;
  setLocal(patch: Partial<Pick<ClientState, 'view' | 'currentProjectId' | 'currentJobId'>>): void;
  project(id: string | null | undefined): Project | undefined;
  /** The workflows this house can see, run and pick as a team: its own (from an older server, its built-ins first). */
  workflowsOf(projectId: string | null | undefined): Workflow[];
  /** One of them by id. */
  workflowOf(projectId: string | null | undefined, id: string | null | undefined): Workflow | undefined;
  agentsOf(projectId: string): AgentInfo[];
  jobsOf(projectId: string): Job[];
  job(projectId: string, jobId: string | null | undefined): Job | undefined;
  /** People of one job: its lead, team members, and helpers spawned by them. */
  agentsOfJob(projectId: string, jobId: string): AgentInfo[];
  /** currentJobId if it still exists in that project, else 'main', else the first job. */
  activeJob(projectId: string): Job | undefined;
}

// ───────────── Rendering engine ─────────────
export type LightingPreset = 'outdoor' | 'indoor';

/** The user's time-of-day choice ('auto' follows the local clock). */
export type TimeOfDayMode = 'auto' | 'day' | 'golden' | 'night';
/** What is on screen right now ('auto' resolved). */
export type TimeOfDayPhase = 'day' | 'golden' | 'night';
/** Time of day as views should react to it (lamps, lit windows, signs). Values change in one step when the phase
 *  changes; the engine dissolves the frame over the switch, so views can simply snap their materials. */
export interface TimeOfDay {
  readonly mode: TimeOfDayMode;
  readonly phase: TimeOfDayPhase;
  /** 0 = daylight … 1 = full night (golden hour ≈ 0.35). Street lamps, lit windows: emissive ∝ mix(dayLevel, 1, night). */
  readonly night: number;
  /** 0..1 how warm and low the sun is (1 at golden hour). */
  readonly golden: number;
}

export interface Assets {
  gltf(url: string): Promise<GLTF>; // cached; callers must clone (SkeletonUtils.clone for skinned)
  texture(url: string, opts?: { srgb?: boolean; repeat?: [number, number] }): THREE.Texture; // cached by url+opts
  /** PBR material from a texture set under /assets/textures. repeat in tiles. */
  pbr(set: PbrSet, repeat?: [number, number], tint?: THREE.ColorRepresentation): THREE.MeshStandardMaterial;
  hdr(url: string): Promise<THREE.Texture>; // equirect HDR (HDRLoader)
}

export type PbrSet =
  | 'asphalt' | 'concrete' | 'paving' | 'grass' | 'brick' | 'plaster'
  | 'woodfloor' | 'laminate' | 'marble';

export interface Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;
  readonly assets: Assets;
  readonly quality: Quality;
  /** Overlay element above the canvas for CSS2D labels (name tags, bubbles, signs). pointer-events: none by default. */
  readonly labelLayer: HTMLElement;
  /** Switch which scene/camera the composer renders and which lighting/post preset applies. */
  setView(scene: THREE.Scene, camera: THREE.PerspectiveCamera, preset: LightingPreset): void;
  setQuality(q: Quality): void;
  /** Per-frame callback, dt in seconds (clamped ≤ 0.1). Returns unsubscribe. */
  onFrame(fn: (dt: number, elapsed: number) => void): () => void;
  /** Raycast from a pointer event against objects (recursive). */
  pick(ev: { clientX: number; clientY: number }, camera: THREE.Camera, objects: THREE.Object3D[]): THREE.Intersection | null;
  /** Fade the whole canvas to black and back (used for city⇄house transitions). */
  fade(toBlack: boolean, ms?: number): Promise<void>;
  setPaused(paused: boolean): void; // focus mode
  /** Time of day (sky, sun/moon, exposure, grade, practical lights). Optional: absent on the flat (no-WebGL) engine. */
  readonly timeOfDay?: TimeOfDay;
  setTimeOfDay?(mode: TimeOfDayMode): void;
  /** Called now with the current value and after every phase change. Returns unsubscribe. */
  onTimeOfDay?(fn: (tod: TimeOfDay) => void): () => void;
}

// ───────────── Views ─────────────
export interface CityView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  init(): Promise<void>; // load assets, build static town
  activate(): void; // attach input handlers, set engine view
  deactivate(): void;
  /** Rebuild/patch project buildings; activity drives window glow & roof beacons (busy / needs-you). */
  sync(city: CityState, agents: Record<string, AgentInfo>, approvals: Record<string, ApprovalRequest>): void;
  flyTo(target: { projectId?: string; landmarkId?: string }): Promise<void>;
  /** Camera move toward the building's door, used right before entering. */
  approach(projectId: string): Promise<void>;
  startDriving(): void;
  stopDriving(): void;
  readonly driving: boolean;
  setPlacementMode(on: boolean): void;
}

export interface HouseView {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  init(): Promise<void>; // preload interior assets + character assets
  enter(project: Project): Promise<void>; // build/reset interior for this project, activate input
  exit(): void;
  readonly projectId: string | null;
  /** (Re)build floors and job rooms for this house: project.floors storeys, one furnished room per job
   *  (furniture by job.kind, name plate = job.name), empty rooms as "available" shells. Cheap when unchanged. */
  syncPlan(project: Project, jobs: Job[]): void;
  /** Show one floor (0 = ground); other floors and the people on them are hidden. Emits 'floor:changed'. */
  showFloor(floor: number): Promise<void>;
  readonly floor: number;
  /** Show the room's floor and frame the room. */
  focusRoom(room: RoomRef): Promise<void>;
  /** Reconcile 3D people with the project's agents (spawn/despawn/retarget activities). Each person stays in
   *  the room of their job (agent.jobId → job.room from syncPlan) and uses that floor's stations. */
  syncAgents(agents: AgentInfo[], approvals: ApprovalRequest[]): void;
  /** Visual handoff: `from` walks to `to` carrying a folder labelled `label`. */
  handoff(fromAgentId: string, toAgentId: string, label: string): void;
  /** Show a speech bubble above a person for ms (e.g. the user's command or the first line of a reply). */
  say(agentId: string, text: string, ms?: number): void;
  setTV(summary: GitSummary | null): void;
  setRunBoard(jobId: string, run: WorkflowRun | null, workflow: Workflow | null): void; // that job's room corkboard shows the pipeline
}

export interface UI {
  mount(root: HTMLElement): void;
  openAgent(agentId: string): void; // side panel → Chat tab for this agent
  openWorkflow(projectId: string): void; // side panel → Workflow tab
  openDiff(projectId: string): void; // full diff viewer overlay
  openPlacement(lotId?: string): void; // place/create project dialog
  openProviders(): void; // Models & Providers panel
  closePanels(): void;
}

export interface AppContext {
  engine: Engine;
  store: Store;
  bus: Bus;
}
