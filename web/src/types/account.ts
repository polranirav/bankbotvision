export type Account = {
  user_id: string;
  first_name: string;
  last_name: string;
  address: string | null;
  date_of_birth: string | null;
  chequing_balance: string;
  savings_balance: string;
  credit_balance: string;
  credit_limit: string;
  credit_score: number | null;
  has_pin: boolean;
  last_login_at: string | null;
  last_login_loc: string | null;
  face_image_path: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountCreate = {
  first_name: string;
  last_name: string;
  address?: string | null;
  date_of_birth?: string | null;
  chequing_balance?: number;
  savings_balance?: number;
  credit_balance?: number;
  credit_limit?: number;
  credit_score?: number | null;
  pin?: string | null;
};

export type AccountUpdate = Partial<AccountCreate>;
