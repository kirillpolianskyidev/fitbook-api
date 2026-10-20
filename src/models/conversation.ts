import {model, Schema, type HydratedDocument, type InferSchemaType} from 'mongoose';

const conversationSchema = new Schema(
  {
    coachId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    clientId: {type: Schema.Types.ObjectId, ref: 'User', required: true},
    lastMessage: {
      type: new Schema(
        {text: String, senderId: Schema.Types.ObjectId, createdAt: Date},
        {_id: false},
      ),
      default: null,
    },
    unread: {
      type: new Schema(
        {coach: {type: Number, default: 0}, client: {type: Number, default: 0}},
        {_id: false},
      ),
      default: () => ({coach: 0, client: 0}),
    },
    lastActivityAt: {type: Date, default: () => new Date()},
  },
  {timestamps: true},
);

conversationSchema.index({coachId: 1, clientId: 1}, {unique: true});
conversationSchema.index({coachId: 1, lastActivityAt: -1});
conversationSchema.index({clientId: 1, lastActivityAt: -1});

export type Conversation = InferSchemaType<typeof conversationSchema>;
export type ConversationDoc = HydratedDocument<Conversation>;
export const ConversationModel = model('Conversation', conversationSchema);
