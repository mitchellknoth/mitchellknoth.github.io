import { getCollection, type CollectionEntry } from 'astro:content';

export function formatPostDate(
  date: Date,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  },
): string {
  return date.toLocaleDateString('en-US', { ...options, timeZone: 'UTC' });
}

export async function getPublishedPosts(): Promise<CollectionEntry<'posts'>[]> {
  return (await getCollection('posts'))
    .filter((post) => !post.data.draft)
    .sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export function splitFeaturedPost(posts: CollectionEntry<'posts'>[]): {
  featured: CollectionEntry<'posts'> | undefined;
  archive: CollectionEntry<'posts'>[];
} {
  const [featured, ...archive] = posts;
  return { featured, archive };
}

export async function getProjects(): Promise<CollectionEntry<'projects'>[]> {
  return (await getCollection('projects')).sort((a, b) => a.data.order - b.data.order);
}
