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
  farewell: { clip: 'farewell', expression: 'relaxed', weight: 0.5 },
};

/** Visemes cycled through while speaking, to suggest articulation. */
const VISEMES = ['aa', 'ih', 'ou', 'ee', 'oh'] as const;

export interface StageOptions {
  cameraHeight: number;
  cameraDistance: number;
  lookAtCursor: boolean;
}

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

    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 40);
    this.scene.add(this.lookTarget);
    this.setupLights();
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

  private applyCamera(): void {
    const { cameraHeight, cameraDistance } = this.options;
    this.camera.position.set(0, cameraHeight, cameraDistance);
    this.camera.lookAt(0, cameraHeight - 0.05, 0);
  }

  setOptions(options: StageOptions): void {
    this.options = options;
    this.applyCamera();
  }

  private resize(): void {
    const host = this.canvas.parentElement;
    const width = Math.max(1, host?.clientWidth ?? this.canvas.clientWidth);
    const height = Math.max(1, host?.clientHeight ?? this.canvas.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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
      this.updateLookAt(delta);
      this.updateBlink(delta);
      this.updateExpression(delta, now);
      this.updateLipSync(delta);
      vrm.update(delta);
    }

    this.renderer.render(this.scene, this.camera);
  }

  private updateLookAt(delta: number): void {
    const height = this.options.cameraHeight;
    const target = this.options.lookAtCursor
      ? new THREE.Vector3(this.pointer.x * 0.6, height + this.pointer.y * 0.35, this.options.cameraDistance)
      : new THREE.Vector3(0, height, this.options.cameraDistance);
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
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.disposeModel();
    this.renderer.dispose();
  }
}
