import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const messageSchema = new Schema({
  conversationId: {type: Schema.Types.ObjectId, ref: 'Conversation', required: true},
  senderId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
  senderRole: {type: String, enum: ['coach', 'client'], required: true},
  text: {type: String, required: true, maxlength: 2000},
  createdAt: {type: Date, default: () => new Date()},
  readAt: {type: Date, default: null},
});

messageSchema.index({conversationId: 1, createdAt: -1});

export type Message = InferSchemaType<typeof messageSchema>;
export type MessageDoc = HydratedDocument<Message>;
export const MessageModel = model('Message', messageSchema);
