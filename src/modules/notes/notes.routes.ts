import {z} from 'zod';

import {AppError} from '../../lib/errors.js';
import {route} from '../../lib/route.js';
import {IdParams, RoleSchema} from '../../lib/schemas.js';
import {addMinutes} from '../../lib/time.js';
import {NoteModel, type NoteDoc} from '../../models/note.js';
import {UserModel, type UserDoc} from '../../models/user.js';
import {getBookingForParticipant} from '../bookings/bookings.service.js';

const EDIT_WINDOW_DAYS = 30;
const PhaseSchema = z.enum(['before', 'after']).meta({id: 'NotePhase'});

const NoteSchema = z
  .object({
    id: z.string(),
    bookingId: z.string(),
    phase: PhaseSchema,
    text: z.string(),
    author: z.object({
      id: z.string(),
      role: RoleSchema,
      firstName: z.string(),
      lastName: z.string(),
    }),
    lastEditedBy: z.object({id: z.string(), role: RoleSchema}),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({id: 'Note'});

const NoteBody = z.object({phase: PhaseSchema, text: z.string().trim().min(1).max(4000)});
const NoteTextBody = z.object({text: z.string().trim().min(1).max(4000)});

async function toNoteDtos(notes: NoteDoc[]) {
  const authors = await UserModel.find({_id: {$in: notes.map(n => n.authorId)}})
    .select('firstName lastName')
    .lean();
  const byId = new Map(authors.map(a => [a._id.toString(), a]));
  return notes.map(note => {
    const author = byId.get(note.authorId.toString());
    return {
      id: note.id as string,
      bookingId: note.bookingId.toString(),
      phase: note.phase as 'before' | 'after',
      text: note.text,
      author: {
        id: note.authorId.toString(),
        role: note.authorRole as 'coach' | 'client',
        firstName: author?.firstName ?? '',
        lastName: author?.lastName ?? '',
      },
      lastEditedBy: {
        id: note.lastEditedById.toString(),
        role: note.lastEditedByRole as 'coach' | 'client',
      },
      createdAt: (note.get('createdAt') as Date).toISOString(),
      updatedAt: (note.get('updatedAt') as Date).toISOString(),
    };
  });
}

const roleOf = (user: UserDoc) => user.role as 'coach' | 'client';

async function editableNote(user: UserDoc, noteId: string) {
  const note = await NoteModel.findById(noteId);
  if (!note) throw new AppError('NOT_FOUND', 'Note not found.');
  const booking = await getBookingForParticipant(user, note.bookingId.toString());
  if (addMinutes(booking.endAt, EDIT_WINDOW_DAYS * 1440) < new Date()) {
    throw new AppError(
      'FORBIDDEN',
      `Notes can be edited up to ${EDIT_WINDOW_DAYS} days after the training.`,
    );
  }
  return note;
}

const tags = ['Notes'];

route({
  method: 'get',
  path: '/bookings/:id/notes',
  tags,
  summary: 'Notes of a training, grouped into before and after',
  auth: 'user',
  params: IdParams,
  response: z.object({before: z.array(NoteSchema), after: z.array(NoteSchema)}),
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    const booking = await getBookingForParticipant(user, params.id);
    const notes = await toNoteDtos(
      await NoteModel.find({bookingId: booking._id}).sort({createdAt: 1}),
    );
    return {
      before: notes.filter(n => n.phase === 'before'),
      after: notes.filter(n => n.phase === 'after'),
    };
  },
});

route({
  method: 'post',
  path: '/bookings/:id/notes',
  tags,
  summary: 'Add a note before or after the training (coach or client of the booking)',
  auth: 'user',
  params: IdParams,
  body: NoteBody,
  response: NoteSchema,
  errors: ['NOT_FOUND'],
  handler: async ({user, params, body}) => {
    const booking = await getBookingForParticipant(user, params.id);
    if (addMinutes(booking.endAt, EDIT_WINDOW_DAYS * 1440) < new Date()) {
      throw new AppError(
        'FORBIDDEN',
        `Notes can be added up to ${EDIT_WINDOW_DAYS} days after the training.`,
      );
    }
    const note = await NoteModel.create({
      bookingId: booking._id,
      coachId: booking.coachId,
      clientId: booking.clientId,
      phase: body.phase,
      text: body.text,
      authorId: user._id,
      authorRole: roleOf(user),
      lastEditedById: user._id,
      lastEditedByRole: roleOf(user),
    });
    const [dto] = await toNoteDtos([note]);
    return dto!;
  },
});

route({
  method: 'patch',
  path: '/notes/:id',
  tags,
  summary: 'Edit a note (both participants can edit any note of their training)',
  auth: 'user',
  params: IdParams,
  body: NoteTextBody,
  response: NoteSchema,
  errors: ['NOT_FOUND'],
  handler: async ({user, params, body}) => {
    const note = await editableNote(user, params.id);
    note.text = body.text;
    note.lastEditedById = user._id;
    note.lastEditedByRole = roleOf(user);
    await note.save();
    const [dto] = await toNoteDtos([note]);
    return dto!;
  },
});

route({
  method: 'delete',
  path: '/notes/:id',
  tags,
  summary: 'Delete a note',
  auth: 'user',
  status: 204,
  params: IdParams,
  errors: ['NOT_FOUND'],
  handler: async ({user, params}) => {
    const note = await editableNote(user, params.id);
    await note.deleteOne();
  },
});
