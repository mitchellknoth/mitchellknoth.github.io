export const site = {
  name: 'Mitchell Knoth',
  shortName: 'Mitch',
  title: 'Mitchell Knoth – Developer Platforms & Coding Agents',
  description:
    'Developer-platform engineer building reliable coding-agent execution, shared context, and production engineering-data systems.',
  location: 'Des Moines, Iowa',
  email: 'mknoth197@gmail.com',
  github: 'https://github.com/mknoth197',
  linkedin: 'https://www.linkedin.com/in/mitchellknoth/',
};

export type NavItem = { label: string; href: string };

export const nav: NavItem[] = [
  { label: 'Writing', href: '/writing/' },
  { label: 'Work', href: '/work/' },
  { label: 'About', href: '/about/' },
];
