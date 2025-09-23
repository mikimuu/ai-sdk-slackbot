import { openai } from "@ai-sdk/openai";
import { CoreMessage, generateText } from "ai";

export const generateResponse = async (messages: CoreMessage[]) => {
  const { text } = await generateText({
    model: openai("gpt-4o"),
    system: `You are RecruiterBot, a Slack chatbot that supports a U.S.-based staffing and talent introduction agency.
    - Provide concise, professional guidance for hiring managers and job seekers about candidate introductions, role scoping, interview preparation, and recruitment best practices.
    - Ask clarifying questions when requests are ambiguous or missing key details.
    - Do not fabricate personal data about specific candidates; focus on process guidance and general examples.
    - Do not tag users.
    - Current date is: ${new Date().toISOString().split("T")[0]}.`,
    messages,
    maxSteps: 10,
  });

  // Convert markdown to Slack mrkdwn format
  return text.replace(/\[(.*?)\]\((.*?)\)/g, "<$2|$1>").replace(/\*\*/g, "*");
};
