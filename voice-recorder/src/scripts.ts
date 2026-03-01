export interface Script {
  id: string;
  language: "zh" | "en";
  category: string;
  text: string;
}

export const SCRIPTS: Script[] = [
  {
    id: "zh-1",
    language: "zh",
    category: "日常对话",
    text: "大家好，我是一个热爱科技的人。今天天气真不错，我们一起去公园散步吧，顺便聊聊最近的新鲜事。",
  },
  {
    id: "zh-2",
    language: "zh",
    category: "新闻播报",
    text: "在这个充满机遇的时代，人工智能正以前所未有的速度改变着我们的生活方式和工作模式。",
  },
  {
    id: "zh-3",
    language: "zh",
    category: "情感表达",
    text: "说实话，当我第一次看到这个结果的时候，真的特别开心，忍不住想和所有人分享这份喜悦。",
  },
  {
    id: "zh-4",
    language: "zh",
    category: "技术介绍",
    text: "语音合成技术通过深度学习模型，将文本转换为自然流畅的语音，广泛应用于智能助手和有声读物等领域。",
  },
  {
    id: "zh-5",
    language: "zh",
    category: "故事叙述",
    text: "从前有一座山，山里有一座庙，庙里住着一位老和尚。有一天，老和尚对小和尚说：我给你讲个故事吧。",
  },
  {
    id: "en-1",
    language: "en",
    category: "Daily Conversation",
    text: "Hi there! My name is a tech enthusiast. The weather looks amazing today. Shall we take a walk in the park and catch up on what's been happening?",
  },
  {
    id: "en-2",
    language: "en",
    category: "News Style",
    text: "In an era defined by rapid innovation, artificial intelligence is transforming the way we live, work, and communicate with one another.",
  },
  {
    id: "en-3",
    language: "en",
    category: "Emotional",
    text: "Honestly, when I first saw the results, I was absolutely thrilled. I couldn't help but want to share this joy with everyone around me.",
  },
  {
    id: "en-4",
    language: "en",
    category: "Technical",
    text: "Text-to-speech technology leverages deep learning models to convert written text into natural, fluent speech, widely used in virtual assistants and audiobooks.",
  },
  {
    id: "en-5",
    language: "en",
    category: "Storytelling",
    text: "Once upon a time, in a land far away, there lived a young inventor who dreamed of building a machine that could understand human emotions.",
  },
];
