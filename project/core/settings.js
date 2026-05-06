export const OWNER='tyler-hattori';
export const REPO='trivia';
export const BRANCH='main';

export const FIELD_SCHEMA=['title','artist','year','movement'];

export const DATASETS=[
  {
    key:'art',
    title:'Art History',
    file:'./datasets/art.csv',
    count:0,
    schema: {type: 'image', fields: FIELD_SCHEMA},
    timeline: {type: 'point'}
  },
  {
    key:'music',
    title:'TBD',
    file:'./datasets/music.csv',
    count:0,
    schema: {type: 'image', fields: FIELD_SCHEMA},
    timeline: {type: 'point'}
  }
];

export const TIMELINE_SETTINGS = {
    MIN_CARD_W: 10,
    MAX_CARD_W: 320,
    IMG_H: 104
}
