import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import {
  VRMAnimationLoaderPlugin,
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation';
import type { Emotion } from '@shared/types';

/**
 * Which VRMA clip and which VRM expression each mood maps to. A missing clip
 * falls back to idle, and a missing expression is simply skipped, so a partial
 * asset install degrades instead of breaking.
 */
const EMOTION_MAP: Record<Emotion, { clip: string; expression?: string; weight: number }> = {
  neutral: { clip: 'idle', expression: 'neutral', weight: 0.4 },
  happy: { clip: 'happy', expression: 'happy', weight: 0.85 },
  thinking: { clip: 'thinking', expression: 'neutral', weight: 0.3 },
  surprised: { clip: 'surprised', expression: 'surprised', weight: 0.9 },
  sad: { clip: 'sad', expression: 'sad', weight: 0.8 },
  angry: { clip: 'angry', expression: 'angry', weight: 0.75 },
  sleepy: { clip: 'sleepy', expression: 'relaxed', weight: 0.7 },
  blush: { clip: 'blush', expression: 'happy', weight: 0.5 },
  proud: { clip: 'proud', expression: 'happy', weight: 0.6 },
  playful: { clip: 'playful', expression: 'happy', weight: 0.7 },
  curious: { clip: 'curious', expression: 'neutral', weight: 0.35 },
  farewell: { clip: 'farewell', expression: 'relaxed', weight: 0.5 },
};

/** Visemes cycled through while speaking, to suggest articulation. */
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

/** How much of the avatar to fill the view with. */
export type Framing = 'full' | 'upper' | 'face';

export interface StageOptions {
  framing: Framing;
  lookAtCursor: boolean;
}

/** Where to aim and how far back to sit, as fractions of the model's height. */
const FRAMING: Record<Framing, { aim: number; fill: number }> = {
  // `aim` is measured down from the top of the head, `fill` is how much of the
  // model's height should occupy the frame.
  full: { aim: 0.5, fill: 1.08 },
  upper: { aim: 0.18, fill: 0.5 },
  face: { aim: 0.07, fill: 0.22 },
};

const MIN_PITCH = -0.9;
const MAX_PITCH = 1.2;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

export class VrmStage {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly clock = new THREE.Clock();
  private readonly loader = new GLTFLoader();

  private vrm: VRM | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private readonly clips = new Map<string, THREE.AnimationClip>();
  private currentAction: THREE.AnimationAction | null = null;
  private currentClipName = '';

  private readonly lookTarget = new THREE.Object3D();
  private readonly pointer = new THREE.Vector2(0, 0);
  private options: StageOptions;

  /* -- camera rig ---------------------------------------------------- */
  /** Computed from the loaded model so any avatar is framed correctly. */
  private modelTop = 1.6;
  private modelHeight = 1.6;
  private modelCentreX = 0;
  private modelCentreZ = 0;
  /** Orbit around the subject, driven by the mouse. */
  private yaw = 0;
  private pitch = 0;
  private zoom = 1;
  private panY = 0;
  /** Where the camera is aiming now, and where it wants to aim. */
  private readonly aimNow = new THREE.Vector3();
  private readonly aimGoal = new THREE.Vector3();
  private aimInitialised = false;
  private dragging: 'orbit' | 'pan' | null = null;
  private lastDrag = { x: 0, y: 0 };
  private disposeInput: (() => void) | null = null;

  private emotion: Emotion = 'neutral';
  private emotionWeight = 0;
  private emotionHoldUntil = 0;

  private speaking = false;
  private speechEnergy = 0;
  private visemeWeights = new Float32Array(VISEMES.length);

  private blinkTimer = 2;
  private blinkPhase = -1;

  private running = false;
  private frameHandle = 0;
  private resizeObserver: ResizeObserver | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, options: StageOptions) {
    this.options = options;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Cap the pixel ratio: a 4K display otherwise quadruples the fill cost for
    // no visible gain on a character this size.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    this.scene.add(this.lookTarget);
    this.setupLights();
    this.attachInput();
    this.applyCamera();

    this.loader.register((parser) => new VRMLoaderPlugin(parser));
    this.loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);
    this.resize();
  }

  private setupLights(): void {
    const key = new THREE.DirectionalLight(0xfff3e4, 2.1);
    key.position.set(1.4, 2.0, 1.8);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0xffa76b, 1.1);
    rim.position.set(-1.8, 1.4, -1.6);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight(0x9ad0ff, 0.5);
    fill.position.set(-1.2, 0.4, 1.6);
    this.scene.add(fill);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
  }

  /**
   * Places the camera from the loaded model's own measurements rather than
   * fixed world coordinates. A hard-coded height only ever frames one avatar
   * correctly; every other model ends up cropped — which is exactly what
   * happened before, showing nothing but a forehead.
   */
  /**
   * Where the camera should be looking.
   *
   * A bounding box is taken from the bind pose, so it cannot follow the avatar
   * once an animation starts moving her — which is how she ended up drifting
   * out of frame. The humanoid bones give live world positions, so the shot
   * stays on her however she moves, and works for any rig.
   */
  private computeAim(): THREE.Vector3 {
    const { aim } = FRAMING[this.options.framing] ?? FRAMING.upper;
    const humanoid = this.vrm?.humanoid;

    if (humanoid) {
      const head = humanoid.getNormalizedBoneNode('head');
      const hips = humanoid.getNormalizedBoneNode('hips');
      if (head && hips) {
        const headPos = head.getWorldPosition(new THREE.Vector3());
        const hipsPos = hips.getWorldPosition(new THREE.Vector3());
        // The head bone sits inside the skull, so lift a little to centre the face.
        const crown = headPos.y + this.modelHeight * 0.07;
        const span = Math.max(0.05, crown - hipsPos.y);
        return new THREE.Vector3(
          (headPos.x + hipsPos.x) / 2,
          crown - span * (aim / 0.5),
          (headPos.z + hipsPos.z) / 2,
        );
      }
    }
    // No humanoid rig: fall back to the measured box.
    return new THREE.Vector3(
      this.modelCentreX,
      this.modelTop - this.modelHeight * aim,
      this.modelCentreZ,
    );
  }

  private applyCamera(): void {
    const { fill } = FRAMING[this.options.framing] ?? FRAMING.upper;

    const target = this.aimNow.clone();
    target.y += this.panY;

    // Distance that makes `fill` of the model's height span the viewport,
    // accounting for the aspect ratio so a narrow window pulls back instead of
    // cropping the sides.
    const vFov = (this.camera.fov * Math.PI) / 180;
    const wanted = this.modelHeight * fill;
    const byHeight = wanted / 2 / Math.tan(vFov / 2);
    const byWidth = byHeight / Math.max(0.35, this.camera.aspect);
    const distance = Math.max(byHeight, byWidth) * this.zoom;

    const cosPitch = Math.cos(this.pitch);
    this.camera.position.set(
      target.x + Math.sin(this.yaw) * cosPitch * distance,
      target.y + Math.sin(this.pitch) * distance,
      target.z + Math.cos(this.yaw) * cosPitch * distance,
    );
    this.camera.lookAt(target);
  }

  /** Measures the avatar so framing works for any model, of any size. */
  private measureModel(vrm: VRM): void {
    const box = new THREE.Box3().setFromObject(vrm.scene);
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    this.modelTop = box.max.y;
    this.modelHeight = Math.max(0.2, size.y);
    this.modelCentreX = centre.x;
    this.modelCentreZ = centre.z;
  }

  /** Returns to the framing preset, discarding any orbiting the user did. */
  resetView(): void {
    this.aimInitialised = false;
    this.yaw = 0;
    this.pitch = 0;
    this.zoom = 1;
    this.panY = 0;
    this.applyCamera();
  }

  setOptions(options: StageOptions): void {
    const framingChanged = options.framing !== this.options.framing;
    this.options = options;
    if (framingChanged) this.resetView();
    else this.applyCamera();
  }

  /* --------------------------- mouse controls --------------------------- */

  private attachInput(): void {
    const canvas = this.canvas;

    const down = (event: PointerEvent): void => {
      // Left drag orbits; right drag, or holding shift, slides the framing up
      // and down so you can look at the face or the feet.
      this.dragging = event.button === 2 || event.shiftKey ? 'pan' : 'orbit';
      this.lastDrag = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId);
    };

    const move = (event: PointerEvent): void => {
      if (!this.dragging) return;
      const dx = event.clientX - this.lastDrag.x;
      const dy = event.clientY - this.lastDrag.y;
      this.lastDrag = { x: event.clientX, y: event.clientY };

      if (this.dragging === 'orbit') {
        this.yaw -= dx * 0.008;
        this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + dy * 0.006));
      } else {
        // Scale the pan by model height so it feels the same on any avatar.
        this.panY += (dy / canvas.clientHeight) * this.modelHeight * 1.2;
      }
      this.applyCamera();
    };

    const up = (event: PointerEvent): void => {
      this.dragging = null;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };

    const wheel = (event: WheelEvent): void => {
      event.preventDefault();
      const factor = Math.exp(event.deltaY * 0.0012);
      this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
      this.applyCamera();
    };

    // Right-drag is a pan, so the context menu would fight it.
    const context = (event: Event): void => event.preventDefault();

    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', wheel, { passive: false });
    canvas.addEventListener('contextmenu', context);

    this.disposeInput = () => {
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      canvas.removeEventListener('wheel', wheel);
      canvas.removeEventListener('contextmenu', context);
    };
  }

  private resize(): void {
    const host = this.canvas.parentElement;
    const width = Math.max(1, host?.clientWidth ?? this.canvas.clientWidth);
    const height = Math.max(1, host?.clientHeight ?? this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Framing distance depends on the aspect ratio, so re-solve it.
    this.applyCamera();
  }

  /** Normalised pointer position in [-1, 1], used for head and eye tracking. */
  setPointer(x: number, y: number): void {
    this.pointer.set(x, y);
  }

  async loadModel(url: string): Promise<void> {
    const gltf = await this.loader.loadAsync(url);
    const vrm = gltf.userData['vrm'] as VRM | undefined;
    if (!vrm) throw new Error('That file does not contain a VRM avatar.');

    this.disposeModel();

    // VRM 0.x faces +Z; rotating makes both spec versions face the camera.
    VRMUtils.rotateVRM0(vrm);
    VRMUtils.combineSkeletons(vrm.scene);

    vrm.scene.traverse((object) => {
      object.frustumCulled = false;
    });

    this.vrm = vrm;
    this.scene.add(vrm.scene);
    this.measureModel(vrm);
    this.resetView();

    if (vrm.lookAt) vrm.lookAt.target = this.lookTarget;

    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.currentAction = null;
    this.currentClipName = '';

    // Re-bind any clips that were loaded before the model arrived.
    if (this.pendingAnimations.size > 0) {
      const pending = new Map(this.pendingAnimations);
      this.pendingAnimations.clear();
      await this.loadAnimations(pending);
    }
    this.playClip('idle', 0);
  }

  private pendingAnimations = new Map<string, string>();

  /**
   * Loads VRMA clips and retargets them onto the current avatar. Clips must be
   * rebuilt whenever the avatar changes, because a VRM animation clip is bound
   * to one humanoid instance.
   */
  async loadAnimations(sources: Map<string, string>): Promise<void> {
    if (!this.vrm) {
      // Remember them; loadModel will retarget once an avatar exists.
      for (const [name, url] of sources) this.pendingAnimations.set(name, url);
      return;
    }
    this.pendingAnimations = new Map(sources);
    this.clips.clear();

    const vrm = this.vrm;
    await Promise.all(
      [...sources].map(async ([name, url]) => {
        try {
          const gltf = await this.loader.loadAsync(url);
          const animations = gltf.userData['vrmAnimations'] as VRMAnimation[] | undefined;
          const animation = animations?.[0];
          if (!animation) return;
          this.clips.set(name, createVRMAnimationClip(animation, vrm));
        } catch (error) {
          // One bad clip must not stop the rest from loading.
          console.warn(`Could not load animation "${name}":`, error);
        }
      }),
    );

    if (this.currentClipName === '' || !this.clips.has(this.currentClipName)) {
      this.playClip('idle', 0.2);
    }
  }

  private playClip(name: string, fade = 0.35): void {
    if (!this.mixer) return;
    const clip = this.clips.get(name) ?? this.clips.get('idle');
    if (!clip) return;
    const resolvedName = this.clips.has(name) ? name : 'idle';
    if (resolvedName === this.currentClipName && this.currentAction) return;

    const next = this.mixer.clipAction(clip);
    next.reset();
    next.setLoop(THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = false;
    next.enabled = true;
    next.setEffectiveWeight(1);

    if (this.currentAction && fade > 0) {
      next.crossFadeFrom(this.currentAction, fade, false).play();
    } else {
      this.currentAction?.stop();
      next.play();
    }
    this.currentAction = next;
    this.currentClipName = resolvedName;
  }

  /**
   * Plays the body language for a mood. Non-neutral moods are held briefly and
   * then relax back to idle so the character never freezes in one pose.
   */
  setEmotion(emotion: Emotion): void {
    this.emotion = emotion;
    this.emotionWeight = 0;
    const mapping = EMOTION_MAP[emotion] ?? EMOTION_MAP.neutral;
    this.playClip(mapping.clip);
    this.emotionHoldUntil = emotion === 'neutral' ? 0 : performance.now() + 7000;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (!speaking) this.speechEnergy = 0;
  }

  /** Called by the speech layer with a 0..1 loudness estimate. */
  setSpeechEnergy(level: number): void {
    this.speechEnergy = Math.max(0, Math.min(1, level));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.clock.start();
    const loop = (): void => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      this.update();
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  private update(): void {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    const now = performance.now();

    this.mixer?.update(delta);

    const vrm = this.vrm;
    if (vrm) {
      this.updateAim(delta);
      this.updateLookAt(delta);
      this.updateBlink(delta);
      this.updateExpression(delta, now);
      this.updateLipSync(delta);
      vrm.update(delta);
    }

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Eases the camera onto the subject. Snapping every frame would make idle
   * sway shake the whole view, so this lags behind deliberately.
   */
  private updateAim(delta: number): void {
    this.aimGoal.copy(this.computeAim());
    if (!this.aimInitialised) {
      this.aimNow.copy(this.aimGoal);
      this.aimInitialised = true;
    } else {
      this.aimNow.lerp(this.aimGoal, Math.min(1, delta * 2.5));
    }
    this.applyCamera();
  }

  private updateLookAt(delta: number): void {
    // She looks toward the camera, offset by where the cursor is, so the gaze
    // stays believable from whatever angle the user has orbited to.
    const eye = this.camera.position;
    const target = this.options.lookAtCursor
      ? new THREE.Vector3(eye.x + this.pointer.x * 0.5, eye.y + this.pointer.y * 0.3, eye.z)
      : eye.clone();
    // Ease rather than snap, so the head turn reads as deliberate.
    this.lookTarget.position.lerp(target, Math.min(1, delta * 4));
  }

  private updateBlink(delta: number): void {
    const expressions = this.vrm?.expressionManager;
    if (!expressions) return;

    if (this.blinkPhase >= 0) {
      this.blinkPhase += delta;
      const duration = 0.16;
      const progress = this.blinkPhase / duration;
      // Triangular open-close curve.
      const weight = progress < 0.5 ? progress * 2 : Math.max(0, 2 - progress * 2);
      expressions.setValue('blink', Math.min(1, weight));
      if (this.blinkPhase >= duration) {
        this.blinkPhase = -1;
        expressions.setValue('blink', 0);
        // Human inter-blink intervals are irregular; randomising avoids a tic.
        this.blinkTimer = 1.8 + Math.random() * 4.2;
      }
      return;
    }

    this.blinkTimer -= delta;
    if (this.blinkTimer <= 0) this.blinkPhase = 0;
  }

  private updateExpression(delta: number, now: number): void {
    const expressions = this.vrm?.expressionManager;
    if (!expressions) return;

    // Let a held mood decay back to neutral after its hold window.
    if (this.emotionHoldUntil > 0 && now > this.emotionHoldUntil) {
      this.emotionHoldUntil = 0;
      this.emotion = 'neutral';
      this.playClip('idle', 0.8);
    }

    const mapping = EMOTION_MAP[this.emotion] ?? EMOTION_MAP.neutral;
    this.emotionWeight += (mapping.weight - this.emotionWeight) * Math.min(1, delta * 3);

    for (const candidate of Object.values(EMOTION_MAP)) {
      if (!candidate.expression) continue;
      const active = candidate.expression === mapping.expression;
      const current = expressions.getValue(candidate.expression) ?? 0;
      const goal = active ? this.emotionWeight : 0;
      expressions.setValue(candidate.expression, current + (goal - current) * Math.min(1, delta * 4));
    }
  }

  private lipPhase = 0;

  private updateLipSync(delta: number): void {
    const expressions = this.vrm?.expressionManager;
    if (!expressions) return;

    if (this.speaking) {
      this.lipPhase += delta;
      // Two detuned oscillators give a mouth rhythm that does not look like a
      // metronome, scaled by the current speech energy.
      const jaw =
        0.5 + 0.5 * Math.sin(this.lipPhase * 17) * Math.sin(this.lipPhase * 6.3 + 1.1);
      const openness = Math.max(0, jaw) * (0.35 + 0.65 * this.speechEnergy);
      const index = Math.floor(this.lipPhase * 7) % VISEMES.length;
      for (let i = 0; i < VISEMES.length; i++) {
        const goal = i === index ? openness : 0;
        const current = this.visemeWeights[i] ?? 0;
        const next = current + (goal - current) * Math.min(1, delta * 18);
        this.visemeWeights[i] = next;
        expressions.setValue(VISEMES[i]!, next);
      }
    } else {
      let settled = true;
      for (let i = 0; i < VISEMES.length; i++) {
        const current = this.visemeWeights[i] ?? 0;
        const next = current * Math.max(0, 1 - delta * 12);
        this.visemeWeights[i] = next;
        expressions.setValue(VISEMES[i]!, next);
        if (next > 0.001) settled = false;
      }
      if (settled) this.lipPhase = 0;
    }
  }

  private disposeModel(): void {
    if (!this.vrm) return;
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    this.mixer = null;
    this.clips.clear();
    this.currentAction = null;
    this.currentClipName = '';
  }

  dispose(): void {
    this.stop();
    this.disposeInput?.();
    this.disposeInput = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeModel();
    this.renderer.dispose();
  }
}
