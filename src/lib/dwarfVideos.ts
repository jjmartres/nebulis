/**
 * Frontend mirror of server/lib/library/dwarfVideos.ts's curated constants.
 * Detection uses `objectType`, not the objectId: the server patches
 * `libraryObjects.objectType` to this exact value once, right after creating
 * the synthetic object (see patchVideosObjectMeta), and that value is already
 * present on every AstroObject the frontend fetches — no id-normalization
 * logic needs duplicating here. Mirrors src/lib/dwarfStartrails.ts, which has
 * the same shape for the Star Trails object.
 */
export const DWARF_VIDEOS_OBJECT_TYPE = 'Timelapse';
