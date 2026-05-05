export interface IGProfileData {
  id: string;
  username: string;
  full_name: string;
  biography: string;
  profile_pic_url: string;
  profile_pic_url_hd?: string;
  is_verified: boolean;
  follower_count: number;
  following_count: number;
  media_count: number;
  external_url?: string;
}

export interface IGReelData {
  id: string;
  shortcode: string;
  caption?: string;
  thumbnail_url?: string;
  video_url?: string;
  video_duration?: number;
  taken_at?: number; // unix timestamp
  like_count: number;
  comment_count: number;
  play_count?: number;
  media_type: number; // 1=image, 2=video, 8=carousel
}

export interface IGApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

export interface NormalizedProfile {
  igUserId: string;
  username: string;
  fullName: string;
  bio: string;
  profilePicUrl: string;
  isVerified: boolean;
  followerCount: number;
  followingCount: number;
  mediaCount: number;
}

export interface NormalizedMedia {
  igMediaId: string;
  mediaType: "REEL" | "IMAGE" | "CAROUSEL" | "VIDEO";
  shortcode: string;
  caption: string;
  thumbnailUrl: string;
  videoUrl: string;
  duration: number;
  publishedAt: Date | null;
  viewCount: number;
  likeCount: number;
  commentCount: number;
}
