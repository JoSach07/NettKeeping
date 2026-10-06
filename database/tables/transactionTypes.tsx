import { getDBConnection, GetResult } from "../dbService";
import { describeError } from '@/utils/userFacingError';

export interface TransactionType{
    Id: number;
    Name: string;
    IsIncome: boolean;
}

export interface GetTransactionTypeResult extends GetResult {
    Data: TransactionType[]
}

export const getTransactionTypes = async (): Promise<GetTransactionTypeResult> => {
    const _db = await getDBConnection();
    if(_db){
        try{
            const transactionTypes: TransactionType[] = await _db.getAllAsync('SELECT * FROM TransactionTypes')
            const response: GetTransactionTypeResult = {
                Status: "Success",
                Data: transactionTypes
            }

            return response;
        } catch (err){
            const response: GetTransactionTypeResult = {
                Status: "Error",
                ...describeError(err, 'Unable to load transaction types.'),
                Data: []
            }

            return response;
        }
    }else{
        const response: GetTransactionTypeResult = {
            Status: "Error",
            Message: "Error opening database connection",
            Data: []
        }

        return response;
    }
}
