import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import type { Lang } from "./types";

const strings = {
  en: {
    title: "Voice Lab",
    subtitle: "Record, manage, and clone voices with AI",
    profiles_title: "Voice Profiles",
    studio_title: "Recording Studio",
    clone_title: "Voice Clone Lab",
    recordings_title: "Recordings",
    filter_all: "All",
    filter_custom: "Custom",
    custom_placeholder: "Type your custom script...",
    record_hint: "Tap to record",
    play: "▶ Play",
    stop: "⏹ Stop",
    discard: "Discard",
    save_upload: "Save & Upload",
    clone_profile: "Voice Profile",
    clone_recording: "Reference Recording",
    clone_text: "Text to Synthesize",
    clone_language: "Language",
    select_profile: "-- Select profile --",
    select_recording: "-- Select recording --",
    clone_text_placeholder: "Enter the text you want to generate...",
    generate: "Generate",
    generating: "Generating voice...",
    result_title: "Generated Audio",
    download: "Download",
    new_profile: "New Voice Profile",
    profile_name_label: "Name",
    name_placeholder: "Enter name...",
    avatar_label: "Avatar",
    cancel: "Cancel",
    create: "Create",
    add_new: "+ New Profile",
    no_recordings: "No recordings yet",
    recording_saved: "Recording saved!",
    profile_created: "Profile created!",
    profile_deleted: "Profile deleted",
    recording_deleted: "Recording deleted",
    select_script_hint:
      "Select a script or write custom text, then tap record",
    tts_online: "TTS Online",
    tts_offline: "TTS Offline",
    recordings_count: "recordings",
    confirm_delete_profile: "Delete this profile and all its recordings?",
    confirm_delete_recording: "Delete this recording?",
    clone_error: "Clone generation failed",
    change_script: "Change",
    start_recording: "Start Recording",
    embedding_pending: "Pending",
    embedding_processing: "Processing",
    embedding_ready: "Ready",
    embedding_failed: "Failed",
    embedding_slow_warning:
      "Embedding not ready. Will process from raw audio (slower).",
    tts_history_title: "Generation History",
    tts_history_empty: "No generation history yet",
    tts_history_processing: "Processing",
    tts_history_completed: "Completed",
    tts_history_failed: "Failed",
    confirm_delete_tts: "Delete this generation?",
    tts_recovered: "Recovered pending clone job",
    tts_duration_label: "Duration",
    nav_profiles: "Profiles",
    nav_studio: "Studio",
    nav_clone: "Clone Lab",
    select_profile_first: "Select a profile first",
    back_to_profiles: "Back to Profiles",
    go_to_clone: "Go to Clone Lab",
    dialog_mode: "Dialog Mode",
    single_mode: "Single Mode",
    dialog_text_placeholder: "[Speaker1] Hello!\n[Speaker2] Hi there!",
    dialog_badge: "Dialog",
    audio_duration: "Audio",
    rtf_label: "RTF",
    unmatched_speakers: "No matching profile for",
  },
  zh: {
    title: "声音实验室",
    subtitle: "录音、管理和 AI 声音克隆",
    profiles_title: "声音档案",
    studio_title: "录音棚",
    clone_title: "声音克隆实验室",
    recordings_title: "录音列表",
    filter_all: "全部",
    filter_custom: "自定义",
    custom_placeholder: "输入自定义文案...",
    record_hint: "点击开始录音",
    play: "▶ 播放",
    stop: "⏹ 停止",
    discard: "丢弃",
    save_upload: "保存上传",
    clone_profile: "声音档案",
    clone_recording: "参考录音",
    clone_text: "合成文本",
    clone_language: "语言",
    select_profile: "-- 选择档案 --",
    select_recording: "-- 选择录音 --",
    clone_text_placeholder: "输入要合成的文本...",
    generate: "生成",
    generating: "正在生成语音...",
    result_title: "生成结果",
    download: "下载",
    new_profile: "新建声音档案",
    profile_name_label: "名称",
    name_placeholder: "输入名称...",
    avatar_label: "头像",
    cancel: "取消",
    create: "创建",
    add_new: "+ 新建档案",
    no_recordings: "暂无录音",
    recording_saved: "录音已保存！",
    profile_created: "档案已创建！",
    profile_deleted: "档案已删除",
    recording_deleted: "录音已删除",
    select_script_hint: "选择一段文案或输入自定义文本，然后点击录音",
    tts_online: "TTS 在线",
    tts_offline: "TTS 离线",
    recordings_count: "条录音",
    confirm_delete_profile: "确定删除该档案及其所有录音？",
    confirm_delete_recording: "确定删除该录音？",
    clone_error: "声音克隆失败",
    change_script: "换文案",
    start_recording: "开始录音",
    embedding_pending: "待处理",
    embedding_processing: "处理中",
    embedding_ready: "就绪",
    embedding_failed: "失败",
    embedding_slow_warning: "声纹未就绪，将从原始音频处理（较慢）。",
    tts_history_title: "生成历史",
    tts_history_empty: "暂无生成历史",
    tts_history_processing: "处理中",
    tts_history_completed: "已完成",
    tts_history_failed: "失败",
    confirm_delete_tts: "确定删除这条生成记录？",
    tts_recovered: "已恢复上次未完成的克隆任务",
    tts_duration_label: "耗时",
    nav_profiles: "声音档案",
    nav_studio: "录音棚",
    nav_clone: "声音克隆",
    select_profile_first: "请先选择一个声音档案",
    back_to_profiles: "返回档案列表",
    go_to_clone: "前往声音克隆",
    dialog_mode: "对话模式",
    single_mode: "单人模式",
    dialog_text_placeholder: "[小明] 你好！\n[小红] 你好呀！",
    dialog_badge: "对话",
    audio_duration: "音频",
    rtf_label: "RTF",
    unmatched_speakers: "未匹配到声音档案",
  },
} as const;

type StringKey = keyof (typeof strings)["en"];

interface I18nContextValue {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: StringKey) => string;
}

const I18nContext = createContext<I18nContextValue>(null!);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Lang>("zh");

  const t = useCallback(
    (key: StringKey) => strings[lang][key] ?? strings.en[key] ?? key,
    [lang]
  );

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
